# Telegram Bookmark helper

Downloads YouTube (and 1000+ other sites) with yt-dlp and uploads the result to your Telegram topic.

## Setup
1. Install Python 3.9+, then: `python -m pip install -U yt-dlp`
2. Install ffmpeg (needed for MP3 and for merging video+audio): https://ffmpeg.org/download.html
3. Run: `python server.py`
4. Copy the printed **secret**. In the extension: Settings → Helper → turn on, paste the secret, press **Test helper**.

## Use
In the popup choose **Video** or **MP3**, or right-click a page/link → Save to Telegram → Download video / audio (helper).
The file appears in the chosen topic when ready. If it fails, the bot posts the reason in the same topic.

## Safety
- Listens on 127.0.0.1 only, requires the secret, rejects requests from web pages (Origin check) and DNS-rebinding hosts.
- Your bot token is sent only from the extension to this local program, then to api.telegram.org.
- Keep it running only when you need it.

## Files over 50 MB
The public Bot API allows 50 MB. To send up to 2 GB, run your own Telegram Bot API server
(https://github.com/tdlib/telegram-bot-api), log your bot out of the cloud API once (`/logOut`), then:
`python server.py --api-base http://127.0.0.1:8081 --max-mb 1900`

---
Telegram Bookmark — developed by asrbmy and linkwithiq
https://asrbmy.github.io · https://linkwithiq.github.io · https://github.com/asrbmy/telegram-bookmark
