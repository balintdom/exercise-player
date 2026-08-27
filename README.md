# Workout Player

Static PWA that plays planned workouts from a private training repo
(`workouts/*.yaml`), one exercise card at a time — description, personal cues,
media, set tracker, rest/duration timers — and commits raw session feedback
back to the repo (`feedback/<workout>.yaml`) via the GitHub API.

**This repo contains only the app. All training data lives in the private
data repo and is accessed directly from the browser with a fine-grained
personal access token (Contents read/write on that single repo), stored in
`localStorage`.**

Hosted on GitHub Pages. Install on a phone via "Add to Home Screen".

Icon: fire emoji from [Noto Emoji](https://github.com/googlefonts/noto-emoji) (Apache 2.0).
