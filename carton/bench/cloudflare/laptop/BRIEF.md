# Carton network test: what it is and how to run it

Thank you for helping. This is a test of Carton, the part of the video editor that lets several people work on the same
project at once. We run it from your laptop and home internet because a real home connection behaves differently from
our server's.

## What it does

It pretends to be a few people editing the same video project at once, all on your laptop, talking to our test server:

- It sends small edits back and forth for about a minute and times how fast each one reaches the others.
- It cuts its own connection for 45 seconds while it keeps editing, as if the Wi-Fi dropped, then reconnects and checks
  that nothing was lost. This does not touch your real Wi-Fi: it only cuts a connection inside the test.
- It uploads a 200 MB test file and then downloads a small part of it back. The file is random data made up in memory.
  Nothing comes from your computer.
- At the end, if there is time, it slows one of its own connections down to the speed of a weak mobile signal and
  edits through it.

It reads none of your files and does not record your IP address. It only talks to our test server. It needs no
administrator rights and installs nothing.

## What you need

- A Windows laptop with Node.js 22.3 or newer. Get the LTS version from https://nodejs.org if you don't have it.
  `node --version` in PowerShell shows which one you have.
- The two files we sent: `cf-lab-laptop.mjs` and `config.json`, both in one folder. `RUN.txt` has the exact commands.

## How to run it

1. Plug the laptop in, use your usual home Wi-Fi, and close video calls or big downloads.
2. Open PowerShell in that folder and run: `node .\cf-lab-laptop.mjs .\config.json`
3. Wait. It prints its progress as it goes. It usually takes 5 to 10 minutes and never more than 20.
   It uses about 220 MB of data, almost all of it the upload.
4. At the end it prints a short summary and the name of the results file it saved in the same folder
   (`cf-lab-results-….json`). Please send that file back to us.

If you need to stop it early, press Ctrl+C. What it measured so far is still saved in that file, so please send it
anyway. If something goes wrong, the file says what. `config.json` works for 48 hours after we made it. After that,
ask us for a new one.
