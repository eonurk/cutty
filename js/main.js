'use strict';

/* Cutty panel logic.
   Runs inside CEP (Chromium). Node.js is enabled via the manifest, which is
   how we shell out to ffmpeg (silence detection, waveform peaks) and
   whisper.cpp (filler-word detection). */

(function () {
  var nodeRequire = null;
  try {
    if (typeof cep_node !== 'undefined' && cep_node && cep_node.require) nodeRequire = cep_node.require;
    else if (typeof require === 'function') nodeRequire = require;
  } catch (e) {}

  var cp = null;
  var fs = null;
  var os = null;
  var pathMod = null;
  try {
    if (nodeRequire) {
      cp = nodeRequire('child_process');
      fs = nodeRequire('fs');
      os = nodeRequire('os');
      pathMod = nodeRequire('path');
    }
  } catch (e) {}

  var isWin = navigator.platform.indexOf('Win') === 0;

  /* ---------------- state ---------------- */

  function $(id) { return document.getElementById(id); }

  var els = {};
  var settings = null;
  var ffmpegPath = '';
  var whisperBin = '';
  var whisperModel = '';
  var lastAnalysis = null; /* { sel, ranges:[{start,end,rt,ri,enabled,kind,label}], wave:{t0,t1,items} } */
  var cachedSel = null;

  var MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
  function defaultModelPath() {
    if (!os || !pathMod) return '';
    var current = pathMod.join(os.homedir(), 'Library', 'Application Support', 'Cutty', 'models', 'ggml-base.bin');
    var legacy = pathMod.join(os.homedir(), 'Library', 'Application Support', 'SilenceCutter', 'models', 'ggml-base.bin');
    try {
      if (fs && !fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
    } catch (e) {}
    return current;
  }

  var DEFAULTS = {
    thresholdDb: -38,
    minSilence: 0.5,
    marginAfterMs: 120,   /* silence kept after speech ends */
    marginBeforeMs: 150,  /* silence kept before speech starts */
    minKeepMs: 200,       /* talks shorter than this get cut through */
    mode: 'ripple',
    zoomOn: false,
    zoomScale: 112,
    crossfadeOn: false,
    duplicateFirst: true,
    preset: 'Paced',
    ffmpegPath: '',
    fillersOn: false,
    fillerWords: 'um, uh, uhm, erm, hmm, mhm',
    whisperPath: '',
    whisperModelPath: ''
  };

  /* AutoCut-style presets: how aggressive the edit feels. */
  var PRESETS = {
    Calm:      { minSilence: 1.2,  marginAfterMs: 200, marginBeforeMs: 250, minKeepMs: 0 },
    Measured:  { minSilence: 0.8,  marginAfterMs: 150, marginBeforeMs: 200, minKeepMs: 100 },
    Paced:     { minSilence: 0.5,  marginAfterMs: 120, marginBeforeMs: 150, minKeepMs: 200 },
    Energetic: { minSilence: 0.35, marginAfterMs: 80,  marginBeforeMs: 100, minKeepMs: 250 },
    Jumpy:     { minSilence: 0.25, marginAfterMs: 40,  marginBeforeMs: 60,  minKeepMs: 300 }
  };

  function loadSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('sc_settings') || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings() {
    try { localStorage.setItem('sc_settings', JSON.stringify(settings)); } catch (e) {}
  }

  function log(msg, kind) {
    els.log.textContent = msg;
    els.log.className = 'log' + (kind ? ' ' + kind : '');
  }

  function setWorkflow(stage) {
    var steps = {
      select: els.workflowSelect,
      review: els.workflowReview,
      apply: els.workflowApply
    };
    var copy = {
      select: ['Ready to analyze', 'Select talking clips in the timeline.'],
      review: ['First cut ready', 'Review each detected range before applying.'],
      apply: ['Applying the cut', 'Premiere is updating the sequence.']
    };
    for (var name in steps) {
      if (!steps.hasOwnProperty(name) || !steps[name]) continue;
      steps[name].className = 'workflowStep' + (name === stage ? ' active' : '');
    }
    if (copy[stage]) {
      if (els.workflowTitle) els.workflowTitle.textContent = copy[stage][0];
      if (els.workflowHint) els.workflowHint.textContent = copy[stage][1];
    }
  }

  /* ---------------- CEP bridge ---------------- */

  function evalScript(src) {
    return new Promise(function (resolve, reject) {
      if (!window.__adobe_cep__) {
        reject(new Error('Not running inside Premiere Pro.'));
        return;
      }
      window.__adobe_cep__.evalScript(src, function (res) {
        if (res === 'EvalScript error.') reject(new Error('ExtendScript call failed — is a project open?'));
        else resolve(res);
      });
    });
  }

  function callHost(fn, payload) {
    var arg = (payload === undefined) ? '' : JSON.stringify(JSON.stringify(payload));
    return evalScript(fn + '(' + arg + ')').then(function (raw) {
      var out;
      try {
        out = JSON.parse(raw);
      } catch (e) {
        throw new Error('Unexpected host response: ' + String(raw).slice(0, 200));
      }
      if (out && out.error) throw new Error(out.error);
      return out;
    });
  }

  /* ---------------- external tools ---------------- */

  function tryBin(path, args) {
    return new Promise(function (resolve) {
      if (!cp || !path) { resolve(false); return; }
      try {
        cp.execFile(path, args, { timeout: 4000 }, function (err) { resolve(!err); });
      } catch (e) { resolve(false); }
    });
  }

  /* GUI apps on macOS get a minimal PATH, so ask a login shell. */
  function whichBin(name) {
    return new Promise(function (resolve) {
      if (!cp || isWin) { resolve(''); return; }
      try {
        cp.execFile('/bin/zsh', ['-lc', 'command -v ' + name], { timeout: 8000 }, function (err, stdout) {
          resolve(err ? '' : String(stdout).trim().split('\n')[0]);
        });
      } catch (e) { resolve(''); }
    });
  }

  function detectBin(candidates, versionArgs, fallbackNames) {
    var idx = 0;
    function next() {
      if (idx >= candidates.length) {
        var n = 0;
        function nextWhich() {
          if (n >= fallbackNames.length) return Promise.resolve('');
          return whichBin(fallbackNames[n++]).then(function (p) {
            if (!p) return nextWhich();
            return tryBin(p, versionArgs).then(function (ok) { return ok ? p : nextWhich(); });
          });
        }
        return nextWhich();
      }
      var cand = candidates[idx++];
      return tryBin(cand, versionArgs).then(function (ok) { return ok ? cand : next(); });
    }
    return next();
  }

  function detectFfmpeg() {
    var candidates = [];
    if (settings.ffmpegPath) candidates.push(settings.ffmpegPath);
    if (isWin) candidates.push('ffmpeg.exe', 'ffmpeg');
    else candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg');
    return detectBin(candidates, ['-version'], isWin ? [] : ['ffmpeg']);
  }

  function detectWhisper() {
    var candidates = [];
    if (settings.whisperPath) candidates.push(settings.whisperPath);
    if (!isWin) {
      candidates.push('/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli',
        '/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp');
    }
    candidates.push('whisper-cli', 'whisper-cpp');
    return detectBin(candidates, ['--help'], isWin ? [] : ['whisper-cli', 'whisper-cpp']);
  }

  function setFfmpegStatus(path) {
    ffmpegPath = path || '';
    if (ffmpegPath) {
      els.ffmpegStatus.textContent = 'Found: ' + ffmpegPath;
      els.ffmpegStatus.className = 'hint ok';
      if (!els.ffmpegPath.value) els.ffmpegPath.value = ffmpegPath;
    } else if (!cp) {
      els.ffmpegStatus.textContent = 'Node.js is disabled in this panel — reinstall the extension.';
      els.ffmpegStatus.className = 'hint bad';
    } else {
      els.ffmpegStatus.textContent = 'ffmpeg not found. Install it (brew install ffmpeg) or paste its path above.';
      els.ffmpegStatus.className = 'hint bad';
    }
  }

  function refreshWhisperStatus() {
    return detectWhisper().then(function (bin) {
      whisperBin = bin || '';
      whisperModel = '';
      var modelPath = settings.whisperModelPath || defaultModelPath();
      try {
        if (fs && modelPath && fs.existsSync(modelPath) && fs.statSync(modelPath).size > 10 * 1024 * 1024) {
          whisperModel = modelPath;
        }
      } catch (e) {}

      els.modelBtn.hidden = !!whisperModel || !whisperBin;
      if (!whisperBin) {
        els.whisperStatus.textContent = 'Whisper not found. Run: brew install whisper-cpp (or paste its path above).';
        els.whisperStatus.className = 'hint bad';
      } else if (!whisperModel) {
        els.whisperStatus.textContent = 'Found ' + whisperBin + ' — model missing.';
        els.whisperStatus.className = 'hint';
      } else {
        els.whisperStatus.textContent = 'Ready: ' + whisperBin + ' · ' + whisperModel.split('/').pop();
        els.whisperStatus.className = 'hint ok';
      }
    });
  }

  function downloadModel() {
    var target = settings.whisperModelPath || defaultModelPath();
    var dir = pathMod.dirname(target);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    var tmp = target + '.part';
    els.modelBtn.disabled = true;
    els.modelBtn.textContent = 'Downloading…';
    els.whisperStatus.textContent = 'Downloading ggml-base.bin (~148 MB) from Hugging Face…';
    els.whisperStatus.className = 'hint';
    cp.execFile('curl', ['-L', '-sS', '--fail', '-o', tmp, MODEL_URL], { maxBuffer: 4 * 1024 * 1024 }, function (err, so, se) {
      els.modelBtn.disabled = false;
      els.modelBtn.textContent = 'Download base model (148 MB)';
      if (err) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        els.whisperStatus.textContent = 'Download failed: ' + String(se || err.message).slice(0, 160);
        els.whisperStatus.className = 'hint bad';
        return;
      }
      try { fs.renameSync(tmp, target); } catch (e3) {}
      refreshWhisperStatus().then(function () {
        if (whisperModel) log('Whisper model downloaded.', 'ok');
      });
    });
  }

  /* ---------------- ffmpeg passes ---------------- */

  function ffArgsBase(item) {
    return [
      '-hide_banner', '-nostats',
      '-ss', String(Math.max(0, item.inPoint)),
      '-t', String(item.outPoint - item.inPoint),
      '-i', item.mediaPath,
      '-vn', '-sn', '-dn'
    ];
  }

  function runSilenceDetect(item) {
    var durSec = item.outPoint - item.inPoint;
    return new Promise(function (resolve, reject) {
      var args = ffArgsBase(item).concat([
        '-af', 'silencedetect=noise=' + settings.thresholdDb + 'dB:d=' + settings.minSilence,
        '-f', 'null', '-'
      ]);
      cp.execFile(ffmpegPath, args, { maxBuffer: 64 * 1024 * 1024 }, function (err, stdout, stderr) {
        var text = String(stderr || '');
        if (err && text.indexOf('silence_') === -1) {
          if (/does not contain any stream|matches no streams|Invalid data found/i.test(text)) {
            reject(new Error('“' + item.name + '” has no readable audio track.'));
          } else {
            reject(new Error('ffmpeg failed: ' + text.split('\n').slice(-6).join(' ').slice(0, 300)));
          }
          return;
        }
        var silences = [];
        var cur = null;
        var re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
        var m;
        while ((m = re.exec(text)) !== null) {
          if (m[1] === 'start') {
            cur = { start: Math.max(0, parseFloat(m[2])) };
          } else if (cur) {
            cur.end = Math.min(durSec, parseFloat(m[2]));
            silences.push(cur);
            cur = null;
          }
        }
        if (cur) { cur.end = durSec; silences.push(cur); } /* ended silent */
        resolve(silences);
      });
    });
  }

  /* Decoded mono peaks for the waveform preview. */
  function runPeaks(item) {
    var durSec = item.outPoint - item.inPoint;
    var rate = durSec > 3600 ? 2000 : (durSec > 900 ? 4000 : 8000);
    return new Promise(function (resolve) {
      var args = ffArgsBase(item).concat(['-ac', '1', '-ar', String(rate), '-f', 's16le', '-']);
      cp.execFile(ffmpegPath, args, { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }, function (err, stdout) {
        if (err || !stdout || stdout.length < 4) { resolve(null); return; }
        var sampleCount = stdout.length >> 1;
        /* copy so the Int16Array view is always 2-byte aligned */
        var ab = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + (sampleCount << 1));
        var samples = new Int16Array(ab);
        var buckets = Math.min(4000, Math.max(600, Math.round(durSec * 20)));
        var per = Math.max(1, Math.ceil(sampleCount / buckets));
        var peaks = new Float32Array(buckets);
        for (var b = 0; b < buckets; b++) {
          var maxAbs = 0;
          var s0 = b * per;
          var s1 = Math.min(sampleCount, s0 + per);
          for (var s = s0; s < s1; s++) {
            var v = samples[s];
            if (v < 0) v = -v;
            if (v > maxAbs) maxAbs = v;
          }
          peaks[b] = maxAbs / 32768;
        }
        resolve(peaks);
      });
    });
  }

  /* "Calculate by AI" — estimate the noise level from clip loudness. */
  function autoThreshold() {
    var item = lastSelectionOrNull();
    if (!item) return;
    els.autoThrBtn.disabled = true;
    log('Measuring clip loudness…');
    var args = ffArgsBase(item).concat(['-af', 'volumedetect', '-f', 'null', '-']);
    cp.execFile(ffmpegPath, args, { maxBuffer: 16 * 1024 * 1024 }, function (err, stdout, stderr) {
      els.autoThrBtn.disabled = false;
      var m = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(String(stderr || ''));
      if (!m) { log('Could not measure loudness on “' + item.name + '”.', 'bad'); return; }
      var mean = parseFloat(m[1]);
      var thr = Math.max(-60, Math.min(-20, Math.round(mean - 10)));
      settings.thresholdDb = thr;
      els.thr.value = thr;
      els.thrVal.textContent = thr + ' dB';
      saveSettings();
      log('Noise level set to ' + thr + ' dB (clip mean ' + mean.toFixed(1) + ' dB).', 'ok');
    });
  }

  function lastSelectionOrNull() {
    if (lastAnalysis) return lastAnalysis.analysisItems[0];
    if (cachedSel) {
      var items = cachedSel.audio.length ? cachedSel.audio : cachedSel.video;
      return items[0];
    }
    return null;
  }

  /* ---------------- whisper (filler words) ---------------- */

  function extractWav(item, wavPath) {
    return new Promise(function (resolve, reject) {
      var args = ffArgsBase(item).concat(['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wavPath]);
      cp.execFile(ffmpegPath, args, { maxBuffer: 8 * 1024 * 1024 }, function (err, so, se) {
        if (err) reject(new Error('Could not extract audio: ' + String(se).slice(-200)));
        else resolve();
      });
    });
  }

  /* Returns [{t0, t1, text}] — one word per entry, times in seconds from the
     clip's in-point. The prompt biases Whisper toward verbatim output so it
     doesn't clean the fillers away. */
  function runWhisper(item) {
    var tmpBase = pathMod.join(os.tmpdir(), 'sc_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
    var wavPath = tmpBase + '.wav';
    return extractWav(item, wavPath).then(function () {
      return new Promise(function (resolve, reject) {
        var args = [
          '-m', whisperModel, '-f', wavPath, '-of', tmpBase,
          '-oj', '-ml', '1', '-sow', '-l', 'auto', '-t', '4', '-np',
          '--prompt', 'Umm, uh, er, ah, hmm, mhm, you know, I mean, like, so...'
        ];
        cp.execFile(whisperBin, args, { maxBuffer: 64 * 1024 * 1024 }, function (err, so, se) {
          try { fs.unlinkSync(wavPath); } catch (e) {}
          if (err) {
            reject(new Error('Whisper failed: ' + String(se || so || err.message).slice(-300)));
            return;
          }
          var words = [];
          try {
            var j = JSON.parse(fs.readFileSync(tmpBase + '.json', 'utf8'));
            var segs = j.transcription || [];
            for (var i = 0; i < segs.length; i++) {
              var off = segs[i].offsets || {};
              words.push({
                t0: (off.from || 0) / 1000,
                t1: (off.to || 0) / 1000,
                text: String(segs[i].text || '')
              });
            }
          } catch (e2) {
            reject(new Error('Could not read Whisper output.'));
            return;
          }
          try { fs.unlinkSync(tmpBase + '.json'); } catch (e3) {}
          resolve(words);
        });
      });
    });
  }

  function normalizeWord(text) {
    return String(text).toLowerCase()
      .replace(/[.,!?;:…"“”'’()\[\]\-–—*]/g, '')
      .replace(/\s+/g, '');
  }

  function fillerSet() {
    var out = {};
    var parts = String(settings.fillerWords || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var w = normalizeWord(parts[i]);
      if (w) out[w] = true;
    }
    return out;
  }

  function buildFillerRanges(words, item, frameSec, sel) {
    var set = fillerSet();
    var pad = 0.04; /* whisper timestamps are ±50ms-ish; cut the whole word */
    var srcDur = item.outPoint - item.inPoint;
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var nw = normalizeWord(w.text);
      if (!nw || !set[nw]) continue;
      if (!(w.t1 > w.t0)) continue;
      var a = Math.max(0, w.t0 - pad);
      var b = Math.min(srcDur, w.t1 + pad);
      /* make sure the cut survives frame snapping */
      if (b - a < frameSec * 1.2) {
        var mid = (a + b) / 2;
        a = Math.max(0, mid - frameSec * 0.6);
        b = Math.min(srcDur, mid + frameSec * 0.6);
      }
      var s = Math.max(item.start, item.start + a);
      var e = Math.min(item.end, item.start + b);
      if (e <= s) continue;
      var target = rippleTargetFor((s + e) / 2, item, sel);
      out.push({ start: s, end: e, rt: target.rt, ri: target.ri, enabled: true, kind: 'filler', label: nw });
    }
    return out;
  }

  /* Fillers already inside a silence cut would be double-counted — drop them. */
  function dedupeFillers(fillers, silences) {
    var out = [];
    for (var i = 0; i < fillers.length; i++) {
      var f = fillers[i];
      var overlapped = false;
      for (var j = 0; j < silences.length; j++) {
        var s = silences[j];
        var ov = Math.min(f.end, s.end) - Math.max(f.start, s.start);
        if (ov > (f.end - f.start) * 0.5) { overlapped = true; break; }
      }
      if (!overlapped) out.push(f);
    }
    return out;
  }

  /* ---------------- range building ---------------- */

  function rippleTargetFor(mid, item, sel) {
    for (var v = 0; v < sel.video.length; v++) {
      if (sel.video[v].start <= mid && mid <= sel.video[v].end) {
        return { rt: 'video', ri: sel.video[v].trackIndex };
      }
    }
    return { rt: sel.audio.length === 0 ? 'video' : 'audio', ri: item.trackIndex };
  }

  /* Silence times are offsets from the clip's source in-point, so
     sequenceTime = clip.start + offset (speed 100% only, checked earlier). */
  function buildCutRanges(silences, item, frameSec, sel) {
    var padAfter = settings.marginAfterMs / 1000;
    var padBefore = settings.marginBeforeMs / 1000;
    var minKeep = settings.minKeepMs / 1000;
    var srcDur = item.outPoint - item.inPoint;
    var minCut = Math.max(frameSec * 2, 0.02);

    var raw = [];
    for (var i = 0; i < silences.length; i++) {
      var a = silences[i].start;
      var b = Math.min(silences[i].end, srcDur);
      var atHead = a <= 0.015;
      var atTail = b >= srcDur - 0.015;
      if (!atHead) a += padAfter;
      if (!atTail) b -= padBefore;
      if (b - a < minCut) continue;
      raw.push({ start: item.start + a, end: item.start + b });
    }

    raw.sort(function (x, y) { return x.start - y.start; });

    /* Cut through talks shorter than "min speech chunk" (avoids confetti edits). */
    var merged = [];
    for (var j = 0; j < raw.length; j++) {
      var last = merged.length ? merged[merged.length - 1] : null;
      if (last && raw[j].start - last.end < minKeep) {
        last.end = Math.max(last.end, raw[j].end);
      } else {
        merged.push({ start: raw[j].start, end: raw[j].end });
      }
    }

    var out = [];
    for (var k = 0; k < merged.length; k++) {
      var s = Math.max(item.start, merged[k].start);
      var e = Math.min(item.end, merged[k].end);
      if (e - s < minCut) continue;
      var target = rippleTargetFor((s + e) / 2, item, sel);
      out.push({ start: s, end: e, rt: target.rt, ri: target.ri, enabled: true, kind: 'silence', label: '' });
    }
    return out;
  }

  function uniqTracks(items) {
    var seen = {};
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var idx = items[i].trackIndex;
      if (!seen['t' + idx]) { seen['t' + idx] = true; out.push(idx); }
    }
    return out;
  }

  function names(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) out.push(items[i].name);
    return out;
  }

  /* ---------------- formatting ---------------- */

  function fmtTime(sec) {
    var sign = sec < 0 ? '-' : '';
    sec = Math.abs(sec);
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    var ss = s.toFixed(1);
    if (s < 10) ss = '0' + ss;
    return sign + m + ':' + ss;
  }

  /* ---------------- analyze ---------------- */

  function analyze() {
    lastAnalysis = null;
    els.results.hidden = true;
    setWorkflow('select');
    if (els.workflowTitle) els.workflowTitle.textContent = 'Analyzing selection';
    if (els.workflowHint) els.workflowHint.textContent = 'Silence detection is running locally.';
    els.analyzeBtn.disabled = true;
    els.analyzeBtn.textContent = 'Reading selection…';
    log('Reading timeline selection…');

    var fillerWarned = false;

    callHost('SC_getSelection')
      .then(function (sel) {
        cachedSel = sel;
        var items = sel.audio.length ? sel.audio : sel.video;
        for (var i = 0; i < items.length; i++) {
          if (!items[i].mediaPath) {
            throw new Error('“' + items[i].name + '” has no media file path (nested sequences and multicam aren’t supported yet).');
          }
          if (Math.abs(items[i].speed - 1) > 0.001) {
            throw new Error('“' + items[i].name + '” isn’t at 100% speed — reset it first.');
          }
        }
        if (!ffmpegPath) {
          throw new Error('ffmpeg isn’t available — check Engine setup at the bottom of the panel.');
        }

        var wantFillers = settings.fillersOn;
        if (wantFillers && (!whisperBin || !whisperModel)) {
          wantFillers = false;
          fillerWarned = true;
        }

        var frameSec = sel.sequence.frameSeconds;
        var allRanges = [];
        var waveItems = [];
        var idx = 0;

        function nextItem() {
          if (idx >= items.length) {
            return { sel: sel, ranges: allRanges, waveItems: waveItems, analysisItems: items };
          }
          var item = items[idx++];
          els.analyzeBtn.textContent = 'Analyzing ' + idx + '/' + items.length + '…';
          log('Analyzing “' + item.name + '” (' + fmtTime(item.outPoint - item.inPoint) + ')…');
          return runSilenceDetect(item).then(function (silences) {
            var silenceRanges = buildCutRanges(silences, item, frameSec, sel);

            function finishItem(fillerRanges) {
              allRanges = allRanges.concat(silenceRanges, dedupeFillers(fillerRanges, silenceRanges));
              return runPeaks(item).then(function (peaks) {
                waveItems.push({ start: item.start, end: item.end, peaks: peaks });
                return nextItem();
              });
            }

            if (wantFillers) {
              els.analyzeBtn.textContent = 'Transcribing ' + idx + '/' + items.length + '…';
              log('Transcribing “' + item.name + '” for fillers — roughly a minute per 10 minutes of audio…');
              return runWhisper(item).then(
                function (words) { return finishItem(buildFillerRanges(words, item, frameSec, sel)); },
                function (err) {
                  fillerWarned = true;
                  console.error(err);
                  return finishItem([]);
                }
              );
            }
            return finishItem([]);
          });
        }
        return nextItem();
      })
      .then(function (r) {
        r.ranges.sort(function (a, b) { return a.start - b.start; });
        if (!r.ranges.length) {
          log('Nothing found — raise the noise level or shorten the minimum silence.', 'warn');
          setWorkflow('select');
          return;
        }
        var t0 = Infinity;
        var t1 = -Infinity;
        for (var i = 0; i < r.waveItems.length; i++) {
          if (r.waveItems[i].start < t0) t0 = r.waveItems[i].start;
          if (r.waveItems[i].end > t1) t1 = r.waveItems[i].end;
        }
        lastAnalysis = {
          sel: r.sel,
          ranges: r.ranges,
          analysisItems: r.analysisItems,
          wave: { t0: t0, t1: t1, items: r.waveItems }
        };
        renderResults();
        if (fillerWarned) {
          log('Done, but filler detection was skipped — check Filler-word removal.', 'warn');
        } else {
          log('Analysis done. Click cuts in the waveform or list to keep them.');
        }
      })
      .catch(function (err) {
        setWorkflow('select');
        if (els.workflowTitle) els.workflowTitle.textContent = 'Check the selection';
        if (els.workflowHint) els.workflowHint.textContent = 'Resolve the message below, then try again.';
        log(err.message, 'bad');
      })
      .then(function () {
        els.analyzeBtn.disabled = false;
        els.analyzeBtn.textContent = 'Analyze selected clips';
      });
  }

  /* ---------------- results rendering ---------------- */

  function enabledRanges() {
    if (!lastAnalysis) return [];
    var out = [];
    for (var i = 0; i < lastAnalysis.ranges.length; i++) {
      if (lastAnalysis.ranges[i].enabled) out.push(lastAnalysis.ranges[i]);
    }
    return out;
  }

  function updateSummary() {
    var ranges = enabledRanges();
    var wave = lastAnalysis.wave;
    var span = 0;
    for (var i = 0; i < wave.items.length; i++) span += wave.items[i].end - wave.items[i].start;
    var total = 0;
    var fillers = 0;
    for (var j = 0; j < ranges.length; j++) {
      total += ranges[j].end - ranges[j].start;
      if (ranges[j].kind === 'filler') fillers++;
    }
    var pct = span > 0 ? Math.round((total / span) * 100) : 0;
    var parts = ranges.length + ' of ' + lastAnalysis.ranges.length + ' cuts';
    if (fillers > 0) parts += ' (' + (ranges.length - fillers) + ' silences, ' + fillers + ' fillers)';
    els.summary.textContent = parts + ' · removes ' + fmtTime(total) + ' of ' + fmtTime(span) + ' (' + pct + '%)';
    els.cutBtn.disabled = ranges.length === 0;
    var verb = settings.mode === 'mute' ? 'Mute' : (settings.mode === 'cutonly' ? 'Cut at' : 'Remove');
    var noun = fillers > 0 ? 'cut' : 'silence';
    els.cutBtn.textContent = verb + ' ' + ranges.length + ' ' + noun + (ranges.length === 1 ? '' : 's');
  }

  function drawWave() {
    if (!lastAnalysis) return;
    var c = els.wave;
    var dpr = window.devicePixelRatio || 1;
    var W = c.clientWidth;
    var H = 64;
    c.width = Math.max(1, Math.round(W * dpr));
    c.height = Math.round(H * dpr);
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var css = getComputedStyle(document.documentElement);
    var colBg = (css.getPropertyValue('--bg') || '#232323').trim();
    var colWave = (css.getPropertyValue('--accent') || '#4cc38a').trim();
    var colBad = (css.getPropertyValue('--bad') || '#e5645a').trim();
    var colWarn = (css.getPropertyValue('--warn') || '#e0b64f').trim();

    ctx.fillStyle = colBg;
    ctx.fillRect(0, 0, W, H);

    var wave = lastAnalysis.wave;
    var t0 = wave.t0;
    var t1 = wave.t1;
    var dur = Math.max(0.001, t1 - t0);

    /* normalize against the loudest bucket */
    var peakMax = 0.05;
    var i, j;
    for (i = 0; i < wave.items.length; i++) {
      var pk = wave.items[i].peaks;
      if (!pk) continue;
      for (j = 0; j < pk.length; j++) if (pk[j] > peakMax) peakMax = pk[j];
    }

    ctx.fillStyle = colWave;
    ctx.globalAlpha = 0.85;
    var mid = H / 2;
    for (var x = 0; x < W; x++) {
      var time = t0 + (x / W) * dur;
      var amp = 0;
      var covered = false;
      for (i = 0; i < wave.items.length; i++) {
        var it = wave.items[i];
        if (time >= it.start && time <= it.end) {
          covered = true;
          if (it.peaks && it.peaks.length) {
            var bi = Math.min(it.peaks.length - 1,
              Math.floor(((time - it.start) / Math.max(0.001, it.end - it.start)) * it.peaks.length));
            amp = it.peaks[bi] / peakMax;
          }
          break;
        }
      }
      if (!covered) continue;
      var h = Math.max(1, amp * (H - 8));
      ctx.fillRect(x, mid - h / 2, 1, h);
    }
    ctx.globalAlpha = 1;

    /* cut overlays: red top bar = silence, amber = filler word */
    for (i = 0; i < lastAnalysis.ranges.length; i++) {
      var r = lastAnalysis.ranges[i];
      var x0 = ((r.start - t0) / dur) * W;
      var x1 = ((r.end - t0) / dur) * W;
      var w = Math.max(1.5, x1 - x0);
      if (r.enabled) {
        ctx.fillStyle = 'rgba(20,20,20,0.72)';
        ctx.fillRect(x0, 0, w, H);
        ctx.fillStyle = r.kind === 'filler' ? colWarn : colBad;
        ctx.fillRect(x0, 0, w, 2.5);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(x0, 0, w, H);
      }
    }
  }

  function waveClick(ev) {
    if (!lastAnalysis) return;
    var rect = els.wave.getBoundingClientRect();
    var frac = (ev.clientX - rect.left) / Math.max(1, rect.width);
    var time = lastAnalysis.wave.t0 + frac * (lastAnalysis.wave.t1 - lastAnalysis.wave.t0);
    var dur = lastAnalysis.wave.t1 - lastAnalysis.wave.t0;
    var slack = dur / Math.max(1, rect.width) * 3; /* ~3px of forgiveness */
    for (var i = 0; i < lastAnalysis.ranges.length; i++) {
      var r = lastAnalysis.ranges[i];
      if (time >= r.start - slack && time <= r.end + slack) {
        toggleRange(i);
        return;
      }
    }
  }

  function toggleRange(i) {
    var r = lastAnalysis.ranges[i];
    r.enabled = !r.enabled;
    var box = document.getElementById('cutchk_' + i);
    if (box) box.checked = r.enabled;
    var row = document.getElementById('cutrow_' + i);
    if (row) row.className = 'listRow' + (r.enabled ? '' : ' off');
    updateSummary();
    drawWave();
  }

  function renderResults() {
    els.list.innerHTML = '';
    for (var k = 0; k < lastAnalysis.ranges.length; k++) {
      (function (idx) {
        var r = lastAnalysis.ranges[idx];
        var row = document.createElement('label');
        row.className = 'listRow';
        row.id = 'cutrow_' + idx;
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.id = 'cutchk_' + idx;
        box.checked = r.enabled;
        box.addEventListener('change', function () { toggleRange(idx); box.checked = r.enabled; });
        var left = document.createElement('span');
        left.textContent = fmtTime(r.start) + ' → ' + fmtTime(r.end);
        row.appendChild(box);
        row.appendChild(left);
        if (r.kind === 'filler') {
          var tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = '“' + r.label + '”';
          row.appendChild(tag);
        }
        var right = document.createElement('span');
        right.className = 'dim';
        right.textContent = (r.end - r.start).toFixed(1) + 's';
        row.appendChild(right);
        els.list.appendChild(row);
      })(k);
    }

    var sel = lastAnalysis.sel;
    var warn = '';
    if (sel.video.length && sel.audio.length) {
      var frameSec = sel.sequence.frameSeconds;
      if (Math.abs(sel.video[0].start - sel.audio[0].start) > frameSec) {
        warn = 'Video and audio items aren’t aligned — cuts follow the audio items.';
      }
    }
    els.resultsHint.textContent = warn || 'Don’t move clips between analyzing and applying.';

    els.results.hidden = false;
    setWorkflow('review');
    updateSummary();
    drawWave();
  }

  /* ---------------- apply ---------------- */

  function applyCuts() {
    if (!lastAnalysis) return;
    var sel = lastAnalysis.sel;
    var ranges = enabledRanges();
    if (!ranges.length) return;

    var payload = {
      ranges: ranges.map(function (r) { return { start: r.start, end: r.end, rt: r.rt, ri: r.ri }; }),
      videoTracks: uniqTracks(sel.video),
      audioTracks: uniqTracks(sel.audio),
      videoNames: names(sel.video),
      audioNames: names(sel.audio),
      mode: settings.mode,
      duplicateFirst: settings.duplicateFirst,
      zoom: { on: settings.zoomOn, scale: settings.zoomScale },
      crossfade: { on: settings.crossfadeOn }
    };

    els.cutBtn.disabled = true;
    els.cutBtn.textContent = 'Working…';
    setWorkflow('apply');
    log('Applying — this can take a moment…');

    callHost('SC_cutSilences', payload)
      .then(function (res) {
        var msg;
        if (res.mode === 'mute') {
          msg = 'Done — muted ' + res.muted + ' segment' + (res.muted === 1 ? '' : 's');
        } else if (res.mode === 'cutonly') {
          msg = 'Done — added cuts around ' + res.removedSegments + ' range' + (res.removedSegments === 1 ? '' : 's');
        } else {
          msg = 'Done — removed ' + res.removedSegments + ' segment' + (res.removedSegments === 1 ? '' : 's') +
            ' (' + fmtTime(res.savedSeconds) + ')';
        }
        msg += ' in “' + res.sequenceName + '”.';
        if (res.zoomed) msg += ' Zoomed ' + res.zoomed + ' segments.';
        if (res.crossfades) msg += ' Added ' + res.crossfades + ' crossfades.';
        if (res.blocked > 0) msg += ' ' + res.blocked + ' delete(s) blocked — check overlapping clips or locked tracks.';
        log(msg, res.blocked > 0 ? 'warn' : 'ok');
        lastAnalysis = null;
        els.results.hidden = true;
        setWorkflow('select');
      })
      .catch(function (err) {
        log(err.message, 'bad');
        els.cutBtn.disabled = false;
        setWorkflow('review');
        if (lastAnalysis) updateSummary();
      });
  }

  /* ---------------- init / bindings ---------------- */

  function bindSlider(id, valId, key, format, clearsPreset) {
    var input = $(id);
    var val = $(valId);
    input.value = settings[key];
    val.textContent = format(settings[key]);
    input.addEventListener('input', function () {
      settings[key] = parseFloat(input.value);
      val.textContent = format(settings[key]);
      if (clearsPreset) {
        settings.preset = '';
        renderPresetChips();
      }
      saveSettings();
    });
    return function refresh() {
      input.value = settings[key];
      val.textContent = format(settings[key]);
    };
  }

  var sliderRefreshers = [];

  function renderPresetChips() {
    var chips = els.presets.children;
    for (var i = 0; i < chips.length; i++) {
      var name = chips[i].getAttribute('data-preset');
      chips[i].className = 'chip' + (settings.preset === name ? ' active' : '');
    }
    if (els.presetBadge) els.presetBadge.textContent = settings.preset || 'Custom';
    updatePlanSummary();
  }

  function updatePlanSummary() {
    if (!els.planSummary || !settings) return;
    var modes = {
      ripple: 'Close gaps',
      gaps: 'Keep spaces',
      cutonly: 'Add cuts only',
      mute: 'Mute pauses'
    };
    var pace = settings.preset ? settings.preset : 'Custom';
    var safety = settings.duplicateFirst ? 'Original protected' : 'Edit original';
    els.planSummary.textContent = pace + ' · ' + (modes[settings.mode] || 'Close gaps') + ' · ' + safety;
  }

  function applyPreset(name) {
    var p = PRESETS[name];
    if (!p) return;
    settings.minSilence = p.minSilence;
    settings.marginAfterMs = p.marginAfterMs;
    settings.marginBeforeMs = p.marginBeforeMs;
    settings.minKeepMs = p.minKeepMs;
    settings.preset = name;
    for (var i = 0; i < sliderRefreshers.length; i++) sliderRefreshers[i]();
    renderPresetChips();
    saveSettings();
  }

  function init() {
    var ids = ['log', 'analyzeBtn', 'cutBtn', 'results', 'summary', 'wave', 'list', 'resultsHint',
      'ffmpegPath', 'ffmpegStatus', 'hostDot', 'presets', 'thr', 'thrVal', 'autoThrBtn',
      'zoomScaleRow', 'fillersOn', 'fillerWords', 'whisperPath', 'whisperStatus', 'modelBtn',
      'workflowSelect', 'workflowReview', 'workflowApply', 'workflowTitle', 'workflowHint',
      'presetBadge', 'planSummary'];
    for (var i = 0; i < ids.length; i++) els[ids[i]] = $(ids[i]);

    settings = loadSettings();

    /* preset chips */
    var chipNames = ['Calm', 'Measured', 'Paced', 'Energetic', 'Jumpy'];
    for (var c = 0; c < chipNames.length; c++) {
      (function (name) {
        var chip = document.createElement('button');
        chip.className = 'chip';
        chip.textContent = name;
        chip.setAttribute('data-preset', name);
        chip.addEventListener('click', function () { applyPreset(name); });
        els.presets.appendChild(chip);
      })(chipNames[c]);
    }
    renderPresetChips();

    bindSlider('thr', 'thrVal', 'thresholdDb', function (v) { return v + ' dB'; }, false);
    sliderRefreshers.push(
      bindSlider('minSil', 'minSilVal', 'minSilence', function (v) { return v.toFixed(2) + ' s'; }, true),
      bindSlider('padAfter', 'padAfterVal', 'marginAfterMs', function (v) { return v + ' ms'; }, true),
      bindSlider('padBefore', 'padBeforeVal', 'marginBeforeMs', function (v) { return v + ' ms'; }, true),
      bindSlider('minKeep', 'minKeepVal', 'minKeepMs', function (v) { return v + ' ms'; }, true)
    );
    bindSlider('zoomScale', 'zoomScaleVal', 'zoomScale', function (v) { return v + '%'; }, false);

    /* mode radios */
    var radios = document.querySelectorAll('input[name="mode"]');
    for (var r = 0; r < radios.length; r++) {
      radios[r].checked = radios[r].value === settings.mode;
      radios[r].addEventListener('change', function () {
        settings.mode = this.value;
        saveSettings();
        updatePlanSummary();
        if (lastAnalysis) updateSummary();
      });
    }

    function bindCheck(id, key, onChange) {
      var input = $(id);
      input.checked = !!settings[key];
      input.addEventListener('change', function () {
        settings[key] = input.checked;
        saveSettings();
        updatePlanSummary();
        if (onChange) onChange();
      });
      return input;
    }
    var zoomBox = bindCheck('zoomOn', 'zoomOn', function () {
      els.zoomScaleRow.className = 'slider sub' + (settings.zoomOn ? '' : ' dimmed');
    });
    els.zoomScaleRow.className = 'slider sub' + (zoomBox.checked ? '' : ' dimmed');
    bindCheck('crossfadeOn', 'crossfadeOn');
    bindCheck('duplicateFirst', 'duplicateFirst');
    bindCheck('fillersOn', 'fillersOn');
    updatePlanSummary();

    /* fillers */
    els.fillerWords.value = settings.fillerWords;
    els.fillerWords.addEventListener('change', function () {
      settings.fillerWords = els.fillerWords.value;
      saveSettings();
    });
    els.whisperPath.value = settings.whisperPath || '';
    els.whisperPath.addEventListener('change', function () {
      settings.whisperPath = els.whisperPath.value.trim();
      saveSettings();
      refreshWhisperStatus();
    });
    els.modelBtn.addEventListener('click', downloadModel);

    els.ffmpegPath.value = settings.ffmpegPath || '';
    els.ffmpegPath.addEventListener('change', function () {
      settings.ffmpegPath = els.ffmpegPath.value.trim();
      saveSettings();
      detectFfmpeg().then(setFfmpegStatus);
    });

    els.analyzeBtn.addEventListener('click', analyze);
    els.cutBtn.addEventListener('click', applyCuts);
    els.autoThrBtn.addEventListener('click', function () {
      if (!ffmpegPath) { log('ffmpeg isn’t available yet.', 'bad'); return; }
      if (!lastSelectionOrNull()) {
        callHost('SC_getSelection').then(function (sel) { cachedSel = sel; autoThreshold(); }).catch(function (e2) { log(e2.message, 'bad'); });
        return;
      }
      autoThreshold();
    });
    els.wave.addEventListener('click', waveClick);
    window.addEventListener('resize', function () { if (lastAnalysis) drawWave(); });

    callHost('SC_ping')
      .then(function () { els.hostDot.className = 'dot ok'; })
      .catch(function (err) {
        els.hostDot.className = 'dot bad';
        log(err.message, 'bad');
      });

    detectFfmpeg().then(setFfmpegStatus);
    refreshWhisperStatus();
  }

  window.onerror = function (msg) {
    if (els.log) log('Panel error: ' + msg, 'bad');
  };

  document.addEventListener('DOMContentLoaded', init);
})();
