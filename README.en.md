# MapleTools — Anime tracking, multi-source search and local media tools

[中文](README.md) · [Web app](https://anime.alcmaple.cn/) · [Desktop downloads](https://github.com/AlcMaple/tools/releases) · [Usage guide](docs/使用场景.md)

MapleTools, developed by [AlcMaple](https://github.com/AlcMaple), combines a web anime tracker with a Windows and macOS desktop application.

## Features and use cases

- **Personal anime tracker / watchlist:** organize anime, episode progress, tags and viewing links.
- **Anime calendar:** browse the current season's weekly release schedule.
- **Bangumi metadata:** look up anime information from Bangumi (BGM / 番组计划).
- **Multi-source anime search and downloads:** the desktop app supports Xifan (稀饭动漫), Girigiri and Aowu (嗷呜动漫), with episode selection and download queue controls.
- **Local media library and playback:** scan local folders and browse video thumbnails; includes a file explorer with previews.
- **Jianguoyun WebDAV sync:** synchronize application data such as watchlists between desktop installations, with conflict handling. This does not upload video files, mount remote media, or imply compatibility with arbitrary WebDAV providers.
- **Web / desktop watchlist sync:** sign into the web account from the desktop app to upload or retrieve tracking data, separately from Jianguoyun sync.
- **Other desktop tools:** game team lookup and a collection of text/image quotes.

The web app focuses on anime schedules, personal tracking, online viewing and community profiles. Downloads, local media management and the additional utilities are desktop features. Bangumi metadata integration does not imply syncing collections back to a Bangumi account.

Desktop releases target Windows x64 and macOS Apple Silicon. Downloading and thumbnail generation require ffmpeg installed on the system. See the [Chinese README](README.md) for installation and development instructions.

MapleTools is an independent application, not an official Xifan or Girigiri client. Third-party source availability may change.
