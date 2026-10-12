<#
  Sleepwalker helper for Windows.

  Started by the VS Code extension for the duration of a session. It:
    - keeps the system awake (SetThreadExecutionState + a named power request,
      visible in `powercfg /requests`);
    - optionally locks the session and turns the display off;
    - reports lid open/close, user input after a grace period, battery,
      temperature and the CPU used by watched agent processes;
    - restores the power settings by itself if VS Code goes away.

  It talks to the extension through stdout, one JSON object per line.
  Everything it holds is released automatically when the process ends.
#>
param(
  [int]$ParentPid = 0,
  [int]$Lock = 0,
  [int]$DisplayOff = 0,
  [int]$DisplayOffDelayMs = 3000,
  [int]$ReturnGraceMs = 10000,
  [int]$StatusIntervalMs = 10000,
  [string]$WatchProcesses = "",
  [string]$RestoreScript = ""
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace Sleepwalker
{
    public class HelperWindow : Form
    {
        [DllImport("kernel32.dll")]
        static extern uint SetThreadExecutionState(uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT context);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool PowerSetRequest(IntPtr handle, int requestType);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr RegisterPowerSettingNotification(IntPtr recipient, ref Guid setting, int flags);

        [DllImport("user32.dll")]
        static extern bool LockWorkStation();

        [DllImport("user32.dll")]
        static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

        [DllImport("kernel32.dll")]
        static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct REASON_CONTEXT
        {
            public uint Version;
            public uint Flags;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string SimpleReasonString;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct LASTINPUTINFO
        {
            public uint cbSize;
            public uint dwTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct SYSTEM_POWER_STATUS
        {
            public byte ACLineStatus;
            public byte BatteryFlag;
            public byte BatteryLifePercent;
            public byte SystemStatusFlag;
            public int BatteryLifeTime;
            public int BatteryFullLifeTime;
        }

        const uint ES_CONTINUOUS = 0x80000000;
        const uint ES_SYSTEM_REQUIRED = 0x00000001;
        const int POWER_REQUEST_CONTEXT_SIMPLE_STRING = 0x1;
        const int PowerRequestSystemRequired = 1;
        const int PowerRequestExecutionRequired = 3;
        const int WM_POWERBROADCAST = 0x0218;
        const int PBT_POWERSETTINGCHANGE = 0x8013;
        const uint WM_SYSCOMMAND = 0x0112;
        const int SC_MONITORPOWER = 0xF170;
        static readonly IntPtr HWND_BROADCAST = new IntPtr(0xFFFF);

        static Guid LidSwitchGuid = new Guid("BA3E0F4D-B817-4094-A2D1-D56379E6A0F3");
        static Guid DisplayStateGuid = new Guid("6FE69556-704A-47A0-8F24-C28D936FDA47");

        readonly int parentPid;
        readonly bool lockScreen;
        readonly bool displayOff;
        readonly int displayOffDelayMs;
        readonly int returnGraceMs;
        readonly int statusIntervalMs;
        readonly string[] watch;
        readonly string restoreScript;

        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly Timer timer = new Timer();
        Process parent;
        IntPtr powerRequest = IntPtr.Zero;
        bool awayTriggered;
        long awayAtMs;
        bool displayOffDone;
        bool graceDone;
        bool inputReported;
        uint inputBaseline;
        long lastStatusMs = long.MinValue / 2;
        bool lidKnown;
        bool lidOpen;
        bool temperatureAvailable = true;
        bool exiting;

        public HelperWindow(int parentPid, bool lockScreen, bool displayOff, int displayOffDelayMs,
            int returnGraceMs, int statusIntervalMs, string watchList, string restoreScript)
        {
            this.parentPid = parentPid;
            this.lockScreen = lockScreen;
            this.displayOff = displayOff;
            this.displayOffDelayMs = Math.Max(0, displayOffDelayMs);
            this.returnGraceMs = Math.Max(returnGraceMs, this.displayOffDelayMs + 2000);
            this.statusIntervalMs = Math.Max(1000, statusIntervalMs);
            this.watch = string.IsNullOrEmpty(watchList)
                ? new string[0]
                : watchList.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
            this.restoreScript = restoreScript;
            this.ShowInTaskbar = false;
            this.FormBorderStyle = FormBorderStyle.None;
            this.Text = "Sleepwalker helper";
        }

        public static void Run(int parentPid, bool lockScreen, bool displayOff, int displayOffDelayMs,
            int returnGraceMs, int statusIntervalMs, string watchList, string restoreScript)
        {
            HelperWindow window = new HelperWindow(parentPid, lockScreen, displayOff, displayOffDelayMs,
                returnGraceMs, statusIntervalMs, watchList, restoreScript);
            window.Start();
            if (!window.exiting)
            {
                Application.Run();
            }
        }

        void Start()
        {
            // Creates the (never shown) window handle so we can receive power notifications.
            IntPtr handle = this.Handle;

            if (SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) == 0)
            {
                Log("SetThreadExecutionState failed");
            }

            try
            {
                REASON_CONTEXT context = new REASON_CONTEXT();
                context.Version = 0;
                context.Flags = POWER_REQUEST_CONTEXT_SIMPLE_STRING;
                context.SimpleReasonString = "Sleepwalker: keeping AI agents running";
                powerRequest = PowerCreateRequest(ref context);
                if (powerRequest != IntPtr.Zero && powerRequest != new IntPtr(-1))
                {
                    PowerSetRequest(powerRequest, PowerRequestSystemRequired);
                    PowerSetRequest(powerRequest, PowerRequestExecutionRequired);
                }
            }
            catch (Exception e)
            {
                Log("Power request not available: " + e.Message);
            }

            if (parentPid > 0)
            {
                try
                {
                    parent = Process.GetProcessById(parentPid);
                }
                catch (Exception)
                {
                    ParentGone();
                    return;
                }
            }

            if (RegisterPowerSettingNotification(handle, ref LidSwitchGuid, 0) == IntPtr.Zero)
            {
                Log("Lid notifications are not available on this machine");
            }
            RegisterPowerSettingNotification(handle, ref DisplayStateGuid, 0);

            timer.Interval = 250;
            timer.Tick += OnTick;
            timer.Start();

            Emit("{\"type\":\"ready\",\"temperature\":" + (ProbeTemperature() ? "true" : "false") + "}");
        }

        // Locks the screen (display-off follows a moment later, from OnTick). Called when the
        // lid actually closes, or, on machines with no lid, after the fallback delay in OnTick.
        void TriggerAway()
        {
            if (awayTriggered) return;
            awayTriggered = true;
            awayAtMs = clock.ElapsedMilliseconds;
            Emit("{\"type\":\"away\"}");
            if (lockScreen && !LockWorkStation())
            {
                Log("LockWorkStation failed");
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_POWERBROADCAST && m.WParam.ToInt64() == PBT_POWERSETTINGCHANGE && m.LParam != IntPtr.Zero)
            {
                Guid setting = (Guid)Marshal.PtrToStructure(m.LParam, typeof(Guid));
                // POWERBROADCAST_SETTING: Guid (16 bytes), DataLength (4 bytes), Data.
                int data = Marshal.ReadInt32(m.LParam, 20);
                if (setting == LidSwitchGuid)
                {
                    bool open = data != 0;
                    bool initial = !lidKnown;
                    if (initial || open != lidOpen)
                    {
                        lidKnown = true;
                        lidOpen = open;
                        Emit("{\"type\":\"lid\",\"open\":" + (open ? "true" : "false") +
                             ",\"initial\":" + (initial ? "true" : "false") + "}");
                        if (!open) TriggerAway();
                    }
                }
                else if (setting == DisplayStateGuid)
                {
                    Emit("{\"type\":\"display\",\"state\":" + data.ToString(CultureInfo.InvariantCulture) + "}");
                }
                m.Result = new IntPtr(1);
                return;
            }
            base.WndProc(ref m);
        }

        void OnTick(object sender, EventArgs e)
        {
            if (exiting) return;
            long now = clock.ElapsedMilliseconds;

            if (parent != null)
            {
                bool gone;
                try { gone = parent.HasExited; }
                catch (Exception) { gone = true; }
                if (gone)
                {
                    ParentGone();
                    return;
                }
            }

            // No lid on this machine (no notification ever arrived): nothing to wait
            // for, so fall back to the fixed delay instead of waiting forever.
            if (!awayTriggered && !lidKnown && now >= displayOffDelayMs)
            {
                TriggerAway();
            }

            if (awayTriggered && !displayOffDone && now >= awayAtMs + (lockScreen ? 800 : 0))
            {
                displayOffDone = true;
                if (displayOff)
                {
                    PostMessage(HWND_BROADCAST, WM_SYSCOMMAND, new IntPtr(SC_MONITORPOWER), new IntPtr(2));
                }
            }

            // Input/focus only count as "the user is back" once the screen actually
            // went away; typing or switching windows before that is normal use.
            if (awayTriggered)
            {
                if (!graceDone)
                {
                    if (now >= awayAtMs + returnGraceMs)
                    {
                        graceDone = true;
                        inputBaseline = LastInputTick();
                    }
                }
                else if (!inputReported)
                {
                    uint last = LastInputTick();
                    if (last != 0 && last != inputBaseline)
                    {
                        inputReported = true;
                        Emit("{\"type\":\"input\"}");
                    }
                }
            }

            if (now - lastStatusMs >= statusIntervalMs)
            {
                lastStatusMs = now;
                EmitStatus();
            }
        }

        static uint LastInputTick()
        {
            LASTINPUTINFO info = new LASTINPUTINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            return GetLastInputInfo(ref info) ? info.dwTime : 0;
        }

        void EmitStatus()
        {
            string battery = "null";
            string ac = "null";
            SYSTEM_POWER_STATUS power;
            if (GetSystemPowerStatus(out power))
            {
                bool hasBattery = power.BatteryFlag != 255 && (power.BatteryFlag & 128) == 0;
                if (hasBattery && power.BatteryLifePercent <= 100)
                {
                    battery = power.BatteryLifePercent.ToString(CultureInfo.InvariantCulture);
                }
                if (power.ACLineStatus == 0) ac = "false";
                else if (power.ACLineStatus == 1) ac = "true";
            }

            string temperature = "null";
            double celsius;
            if (TryReadTemperature(out celsius))
            {
                temperature = celsius.ToString("0.0", CultureInfo.InvariantCulture);
            }

            string cpu = "null";
            int count = 0;
            if (watch.Length > 0)
            {
                double seconds = 0;
                foreach (string name in watch)
                {
                    Process[] found;
                    try { found = Process.GetProcessesByName(name.Trim()); }
                    catch (Exception) { continue; }
                    foreach (Process p in found)
                    {
                        try
                        {
                            seconds += p.TotalProcessorTime.TotalSeconds;
                            count++;
                        }
                        catch (Exception)
                        {
                            // Elevated or other users' processes cannot be measured; skip them.
                        }
                        finally
                        {
                            p.Dispose();
                        }
                    }
                }
                cpu = seconds.ToString("0.000", CultureInfo.InvariantCulture);
            }

            Emit("{\"type\":\"status\",\"battery\":" + battery + ",\"ac\":" + ac +
                 ",\"temp\":" + temperature + ",\"cpu\":" + cpu +
                 ",\"procs\":" + count.ToString(CultureInfo.InvariantCulture) + "}");
        }

        bool ProbeTemperature()
        {
            double ignored;
            return TryReadTemperature(out ignored);
        }

        bool TryReadTemperature(out double celsius)
        {
            celsius = 0;
            if (!temperatureAvailable) return false;
            try
            {
                ObjectQuery query = new ObjectQuery("SELECT CurrentTemperature FROM MSAcpi_ThermalZoneTemperature");
                System.Management.EnumerationOptions options = new System.Management.EnumerationOptions();
                options.Timeout = TimeSpan.FromSeconds(3);
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(new ManagementScope("root\\WMI"), query, options))
                using (ManagementObjectCollection results = searcher.Get())
                {
                    double max = double.MinValue;
                    bool any = false;
                    foreach (ManagementBaseObject item in results)
                    {
                        using (item)
                        {
                            double tenthsOfKelvin = Convert.ToDouble(item["CurrentTemperature"], CultureInfo.InvariantCulture);
                            double c = tenthsOfKelvin / 10.0 - 273.15;
                            if (c > 0 && c < 150)
                            {
                                any = true;
                                if (c > max) max = c;
                            }
                        }
                    }
                    if (!any)
                    {
                        temperatureAvailable = false;
                        Log("No usable ACPI thermal zone found");
                        return false;
                    }
                    celsius = max;
                    return true;
                }
            }
            catch (Exception e)
            {
                temperatureAvailable = false;
                Log("Temperature sensors need administrator rights on this machine: " + e.Message);
                return false;
            }
        }

        void ParentGone()
        {
            if (exiting) return;
            exiting = true;
            timer.Stop();
            Log("VS Code went away; restoring power settings");
            if (!string.IsNullOrEmpty(restoreScript) && System.IO.File.Exists(restoreScript))
            {
                try
                {
                    ProcessStartInfo info = new ProcessStartInfo("cmd.exe", "/d /c \"" + restoreScript + "\"");
                    info.CreateNoWindow = true;
                    info.UseShellExecute = false;
                    using (Process p = Process.Start(info))
                    {
                        p.WaitForExit(20000);
                    }
                }
                catch (Exception e)
                {
                    Log("Restore failed: " + e.Message);
                }
            }
            Application.Exit();
        }

        static void Log(string message)
        {
            Emit("{\"type\":\"log\",\"message\":\"" + Escape(message) + "\"}");
        }

        static void Emit(string json)
        {
            try
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
            catch (Exception)
            {
                // Nobody is listening any more; nothing to do.
            }
        }

        static string Escape(string s)
        {
            if (s == null) return "";
            StringBuilder sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                if (c == '\\') sb.Append("\\\\");
                else if (c == '"') sb.Append("\\\"");
                else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(c);
            }
            return sb.ToString();
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp `
    -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Management | Out-Null
} catch {
  $message = ($_.Exception.Message -replace '\\', '\\' -replace '"', '\"' -replace "[\r\n]+", ' ')
  [Console]::Out.WriteLine('{"type":"fatal","message":"Could not start the helper: ' + $message + '"}')
  exit 2
}

[Sleepwalker.HelperWindow]::Run($ParentPid, ($Lock -ne 0), ($DisplayOff -ne 0), $DisplayOffDelayMs,
  $ReturnGraceMs, $StatusIntervalMs, $WatchProcesses, $RestoreScript)
