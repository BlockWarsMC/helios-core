# BlockWars Helios Core

Core mechanisms for BlockWarsLauncher, forked from
[dscalzi/helios-core](https://github.com/dscalzi/helios-core).
The fork is configured to publish as `@blockwarsmc/helios-core` through GitHub Packages.

### Requirements

* Node.js 22 (minimum)

helios-core will always use the same minimum node version as Helios Launcher.

## Auth

### Supported Auth Providers

* Mojang
* Microsoft

### Provider Information

#### Mojang

Mojang authentication makes use of the Yggdrasil scheme. See https://wiki.vg/Authentication

#### Microsoft

Microsoft authentication uses OAuth 2.0 with Azure. See https://wiki.vg/Microsoft_Authentication_Scheme

### LICENSE

LGPL-3.0
