# Changelog

## 0.1.3

- Fixed: on laptops where Windows hides the "Lid close action" power setting, Sleepwalker failed to start with "Could not read the power setting". It now reads hidden settings too (`powercfg /qh`).

## 0.1.2

- Simplified e-mail setup: the only thing asked up front is the e-mail that receives notifications. The sending account, password, provider, server and port are tucked under "Advanced", for the rare case the defaults don't fit.
- Improved the lid-closing animation in the panel: the screen now folds shut on its hinge instead of flattening, with a soft settle and a contact shadow, instead of a flat squash.

## 0.1.1

- Fixed: the screen used to lock/turn off a few seconds after pressing "Start sleepwalking", even with the lid open. Now it waits for the lid to actually close (machines with no lid keep the old short delay, since there is nothing to wait for).
- Fixed: typing or switching windows while the lid was still open could be mistaken for "the user is back" and end the session early. Return detection now only arms after the screen has actually gone away.
- Notifications are now a step of their own, right under "Start sleepwalking", instead of being buried below the other settings.

## 0.1.0

First release.

- Sleepwalking sessions on Windows and Linux: screen off, session locked, computer awake with the lid closed.
- Three modes: until I come back, while the agent works, for a set time.
- Ends when you open the lid or touch the keyboard, and restores every setting, even after a crash.
- Battery, temperature and time-limit guards.
- E-mail notifications over SMTP, with the password in VS Code's secret storage.
- Side panel, status bar entry, English and Brazilian Portuguese.
