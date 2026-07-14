# Cutty — silence editing for Premiere Pro

Cutty removes dead air from talking clips without taking creative control away.
Select clips in Premiere Pro, analyze locally, review every proposed cut on a
waveform, then apply the edit to a protected duplicate sequence.

Detection runs locally through ffmpeg's `silencedetect` filter. Footage is never
uploaded.

## Download

Download the latest `Cutty-v*.zip` from the
[GitHub Releases](https://github.com/eonurk/cutty/releases/latest) page, unzip
it, then run:

```sh
cd ~/Downloads/Cutty
./install.sh
```

Restart Premiere Pro and open **Window ▸ Extensions ▸ Cutty**.

## Requirements

- macOS, Adobe Premiere Pro 2020 or newer (CEP extension support)
- ffmpeg (`brew install ffmpeg`) — auto-detected, path is editable in the panel

## Install from source

```sh
./install.sh
```

Then restart Premiere Pro and open **Window ▸ Extensions ▸ Cutty**.

The installer copies the panel to `~/Library/Application Support/Adobe/CEP/extensions/`
and enables `PlayerDebugMode` (the standard flag that lets Premiere load
unsigned/development panels; `uninstall.sh` can revert it).

## Usage

1. Open your sequence and **select the talking clip(s)** in the timeline
   (multiple clips are fine; linked audio selected along with them is fine).
   The panel shows how many clips are selected as soon as you mouse over it.
2. **Analyze selected clips** — the preview shows the waveform with every cut
   marked, plus a list. Hover the waveform to inspect a cut and click it (or
   its list row) to toggle it; **All / None** toggles every cut at once. The ▶
   button on a row parks Premiere's playhead just before that cut so you can
   audition it with the spacebar.
3. Adjust settings or pick a preset and re-analyze until it looks right — the
   results flag themselves as stale whenever a detection setting changes.
4. Apply.

### Presets

**Calm · Measured · Paced · Energetic · Jumpy** — from gentle podcast-style
trimming to aggressive jump-cut YouTube pacing. Presets set the four timing
sliders; the noise level stays yours.

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Noise level | −38 dB | Audio below this counts as silence. **Auto** measures the clip and sets it for you. |
| Remove silences longer than | 0.5 s | Shorter pauses are kept. |
| Padding after speech | 120 ms | Silence kept after a sentence ends, so words aren't clipped. |
| Padding before speech | 150 ms | Silence kept before speech resumes. |
| Remove talks shorter than | 200 ms | Speech blips shorter than this between two silences get cut through (avoids confetti edits). |

### Silence handling

- **Remove, close gaps** — ripple delete (the classic AutoCut behaviour).
- **Remove, keep spaces** — delete but leave the gaps for manual review.
- **Keep, just cut** — only razor at the boundaries; nothing is deleted.
- **Mute** — razor and silence the audio segments, keep everything in place.

### Filler words

Enable **Remove filler words** to also cut "um", "uh", etc. This transcribes
the clip locally with [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
(`brew install whisper-cpp`) plus a model file — the panel offers a one-click
download of `ggml-base.bin` (~148 MB, from Hugging Face) and stores it in
`~/Library/Application Support/Cutty/models/`.

- The word list is editable (comma-separated, single words). For Turkish
  content try adding `ee, ıı, şey` — but beware words like "yani" that are
  often meaningful.
- Filler cuts show in **amber** on the waveform (silences are red) and carry
  the matched word in the list, so you can vet each one before applying.
- Expect good-but-not-perfect recall: Whisper tends to clean up disfluencies,
  so the panel prompts it toward verbatim output, but some fillers will still
  slip through. Transcription takes roughly a minute per 10 minutes of audio
  on Apple Silicon.
- For better accuracy, download `ggml-small.bin` (~488 MB) from the same
  Hugging Face repo and point the model path at it.

### Profanity muting

Enable **Mute profanity** (in Speech tools) to silence swear words in place:
each detected word is razored and its audio level set to zero, so the timing
of the video never changes. Muted words show in **green** on the waveform and
carry a `· mute` tag in the list. The word list is editable — Whisper
sometimes censors its own output, so add variants like `f***` if needed.

### Captions

**Export captions (.srt)** (in Speech tools) transcribes the selected clips
locally and writes an SRT whose timestamps match the timeline as it is right
now — so run it on the finished sequence, after cutting. Import the file into
Premiere with **File ▸ Import** to get a caption track.

### Extras

- **Constant Power crossfade at cuts** — smooths audio junctions after removal.
- **Alternate punch-in zoom** — every other kept segment gets a relative
  punch-in (default 112% of that clip’s existing scale) to hide jump cuts.
  It only applies when silences are removed, and leaves keyframed scale alone.
- **Work on a duplicate** (default on) — clones the sequence and edits the
  copy. Recommended: Premiere has no undo grouping for scripts, so undoing a
  run is one Cmd+Z per segment.

## How it works

1. ExtendScript reads the selected clips (media path, source in/out, timeline position).
2. ffmpeg runs `silencedetect` (and a peaks pass for the waveform) on just the
   used portion of each source file.
3. Silence ranges are padded, merged, mapped to sequence time, and frame-snapped.
4. QE DOM razors the clips' tracks at every boundary; silent segments are then
   deleted right-to-left — linked audio without ripple, then one ripple delete
   per segment closes the gap across the timeline.

## Limitations / tips

- **Music or B-roll on other tracks:** a clip spanning a cut on another
  unlocked track can block the ripple delete. Lock those tracks first, or use
  "Remove, keep spaces" and close gaps manually.
- Speed-changed clips (≠100%), nested sequences, and multicam clips aren't
  supported yet.
- If both video and separate audio are selected, detection runs on the **audio
  items'** media and cuts follow their timing.
- Multi-audio-stream media: ffmpeg analyzes the default stream.
- Filler matching is single-word only for now ("you know" won't match as a
  phrase). Premiere's built-in **Text-Based Editing** is an alternative for
  transcript-based editing.

## Debugging

The panel logs to its footer line. For a full console, open
<http://localhost:8092> in Chrome while the panel is open in Premiere
(remote debugging is enabled via the `.debug` file).

To iterate on the UI without Premiere, serve the repo and open
`index.html?mock=1` in a browser — Analyze/Apply run against synthetic data.

## Uninstall

```sh
./uninstall.sh
```
