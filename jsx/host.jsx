/* Cutty — ExtendScript host for Adobe Premiere Pro.
   Loaded automatically via the CSXS manifest ScriptPath.
   Every entry point returns a JSON string.
   ExtendScript is ES3: var/function only, no JSON, no Array extras. */

var SC_TICKS_PER_SECOND = 254016000000;

/* ---------------- tiny JSON (ExtendScript has none) ---------------- */

function SC_jsonEscape(s) {
  s = String(s);
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    var code = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32) out += '\\u' + ('000' + code.toString(16)).slice(-4);
    else out += ch;
  }
  return out;
}

function SC_toJson(v) {
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return '"' + SC_jsonEscape(v) + '"';
  if (v instanceof Array) {
    var parts = [];
    for (var i = 0; i < v.length; i++) parts.push(SC_toJson(v[i]));
    return '[' + parts.join(',') + ']';
  }
  var kv = [];
  for (var k in v) {
    if (v.hasOwnProperty && !v.hasOwnProperty(k)) continue;
    kv.push('"' + SC_jsonEscape(k) + '":' + SC_toJson(v[k]));
  }
  return '{' + kv.join(',') + '}';
}

/* Input always comes from our own panel, never from user-typed text. */
function SC_fromJson(s) {
  return eval('(' + s + ')');
}

/* ---------------- entry points ---------------- */

function SC_ping() {
  return SC_toJson({ ok: true, version: app.version });
}

function SC_describeItem(it, trackIndex) {
  var mediaPath = '';
  try {
    if (it.projectItem) mediaPath = String(it.projectItem.getMediaPath());
  } catch (e) {}
  var speed = 1;
  try { speed = it.getSpeed(); } catch (e2) {}
  return {
    name: String(it.name),
    trackIndex: trackIndex,
    start: it.start.seconds,
    end: it.end.seconds,
    inPoint: it.inPoint.seconds,
    outPoint: it.outPoint.seconds,
    mediaPath: mediaPath,
    speed: speed
  };
}

/* Returns every selected clip in the active sequence plus sequence timing. */
function SC_getSelection() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return SC_toJson({ error: 'Open a sequence first.' });

    var video = [];
    var audio = [];
    var t, c, tr, it;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
      tr = seq.videoTracks[t];
      for (c = 0; c < tr.clips.numItems; c++) {
        it = tr.clips[c];
        if (it.isSelected()) video.push(SC_describeItem(it, t));
      }
    }
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
      tr = seq.audioTracks[t];
      for (c = 0; c < tr.clips.numItems; c++) {
        it = tr.clips[c];
        if (it.isSelected()) audio.push(SC_describeItem(it, t));
      }
    }

    if (video.length === 0 && audio.length === 0) {
      return SC_toJson({ error: 'Select the talking clip(s) in the timeline first (click so they highlight).' });
    }

    var ticksPerFrame = Number(seq.timebase);
    return SC_toJson({
      ok: true,
      video: video,
      audio: audio,
      sequence: {
        name: String(seq.name),
        frameSeconds: ticksPerFrame / SC_TICKS_PER_SECOND
      }
    });
  } catch (e) {
    return SC_toJson({ error: 'Could not read the selection: ' + e.toString() });
  }
}

function SC_duplicateActiveSequence() {
  var proj = app.project;
  var before = {};
  var i, s;
  for (i = 0; i < proj.sequences.numSequences; i++) {
    before[String(proj.sequences[i].sequenceID)] = true;
  }
  proj.activeSequence.clone();
  for (i = 0; i < proj.sequences.numSequences; i++) {
    s = proj.sequences[i];
    if (!before[String(s.sequenceID)]) {
      proj.openSequence(s.sequenceID);
      return { ok: true, name: String(s.name) };
    }
  }
  return { error: 'Could not duplicate the sequence.' };
}

/* ---------------- effect helpers ---------------- */

function SC_setComponentProp(item, componentName, propName, value) {
  try {
    var comps = item.components;
    for (var i = 0; i < comps.numItems; i++) {
      if (String(comps[i].displayName) === componentName) {
        var props = comps[i].properties;
        for (var j = 0; j < props.numItems; j++) {
          if (String(props[j].displayName) === propName) {
            props[j].setValue(value, true);
            return true;
          }
        }
      }
    }
  } catch (e) {}
  return false;
}

/* Constant Power crossfade wherever two of our clips touch after cutting. */
function SC_applyCrossfades(qeSeq, audioTrackIndexes, nameSet, ticksPerFrame) {
  var applied = 0;
  var trans = null;
  try { trans = qe.project.getAudioTransitionByName('Constant Power'); } catch (e) {}
  if (!trans) return 0;
  for (var t = 0; t < audioTrackIndexes.length; t++) {
    var qtr = null;
    try { qtr = qeSeq.getAudioTrackAt(audioTrackIndexes[t]); } catch (e2) { continue; }
    if (!qtr) continue;
    var prev = null;
    for (var i = 0; i < qtr.numItems; i++) {
      var it = null;
      try { it = qtr.getItemAt(i); } catch (e3) { continue; }
      if (!it) continue;
      var type = '';
      try { type = String(it.type); } catch (e4) {}
      if (type === 'Empty') { prev = null; continue; }
      var nm = '';
      try { nm = String(it.name); } catch (e5) {}
      if (prev !== null && nameSet[nm]) {
        var pn = '';
        try { pn = String(prev.name); } catch (e6) {}
        if (nameSet[pn]) {
          var gap = ticksPerFrame * 2;
          try { gap = Math.abs(Number(it.start.ticks) - Number(prev.end.ticks)); } catch (e7) {}
          if (gap <= ticksPerFrame) {
            try {
              it.addAudioTransition(trans);
              applied++;
            } catch (e8) {
              try { it.addAudioTransition(trans, true); applied++; } catch (e9) {}
            }
          }
        }
      }
      prev = it;
    }
  }
  return applied;
}

/* ---------------- the cut ---------------- */

/* payload: {
     ranges: [{start, end, rt, ri}]   silent parts, sequence seconds;
                                      rt/ri = ripple track type ('video'|'audio') + index
     videoTracks: [int], audioTracks: [int]   tracks to razor / edit on
     videoNames: [string], audioNames: [string]   names of the processed clips
     mode: 'ripple' | 'gaps' | 'cutonly' | 'mute'
     duplicateFirst: bool
     zoom: { on: bool, scale: number }
     crossfade: { on: bool }
   } */
function SC_cutSilences(payloadJson) {
  try {
    var p = SC_fromJson(payloadJson);
    var seq = app.project.activeSequence;
    if (!seq) return SC_toJson({ error: 'No active sequence.' });

    if (p.duplicateFirst) {
      var dup = SC_duplicateActiveSequence();
      if (dup.error) return SC_toJson(dup);
      seq = app.project.activeSequence;
    }

    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) return SC_toJson({ error: 'QE sequence unavailable.' });

    var ticksPerFrame = Number(seq.timebase);
    var frameSec = ticksPerFrame / SC_TICKS_PER_SECOND;
    var i;

    /* Snap ranges to frame boundaries, drop sub-frame ones, merge overlaps. */
    var ranges = [];
    for (i = 0; i < p.ranges.length; i++) {
      var f0 = Math.round(p.ranges[i].start / frameSec);
      var f1 = Math.round(p.ranges[i].end / frameSec);
      if (f1 - f0 >= 1) ranges.push({ f0: f0, f1: f1, rt: p.ranges[i].rt, ri: p.ranges[i].ri });
    }
    ranges.sort(function (a, b) { return a.f0 - b.f0; });
    var merged = [];
    for (i = 0; i < ranges.length; i++) {
      var last = merged.length ? merged[merged.length - 1] : null;
      if (last && ranges[i].f0 <= last.f1) {
        if (ranges[i].f1 > last.f1) last.f1 = ranges[i].f1;
      } else {
        merged.push(ranges[i]);
      }
    }
    if (!merged.length) return SC_toJson({ error: 'Nothing to cut — every range is shorter than one frame.' });

    function razorAt(frame) {
      /* Move the CTI so QE hands us a correctly formatted timecode string
         (sidesteps drop-frame formatting entirely). */
      seq.setPlayerPosition(String(frame * ticksPerFrame));
      var tc = String(qeSeq.CTI.timecode);
      var j;
      for (j = 0; j < p.videoTracks.length; j++) {
        try { qeSeq.getVideoTrackAt(p.videoTracks[j]).razor(tc); } catch (eV) {}
      }
      for (j = 0; j < p.audioTracks.length; j++) {
        try { qeSeq.getAudioTrackAt(p.audioTracks[j]).razor(tc); } catch (eA) {}
      }
    }

    /* Razor every boundary first: all times are pre-shift, and removal
       happens right-to-left afterwards so earlier cuts stay valid. */
    for (i = 0; i < merged.length; i++) {
      razorAt(merged[i].f0);
      razorAt(merged[i].f1);
    }

    var eps = frameSec * 0.5 + 0.000001;
    var blocked = 0;

    function eachInRange(track, secStart, secEnd, fn) {
      var n = 0;
      for (var c = track.clips.numItems - 1; c >= 0; c--) {
        var item = track.clips[c];
        if (item.start.seconds >= secStart - eps && item.end.seconds <= secEnd + eps) {
          if (fn(item)) n++;
        }
      }
      return n;
    }

    function removeItem(ripple) {
      return function (item) {
        try {
          item.remove(ripple === true, true);
          return true;
        } catch (eR) {
          blocked++;
          return false;
        }
      };
    }

    var removedSegments = 0;
    var savedSeconds = 0;
    var muted = 0;
    var ti;

    if (p.mode === 'mute') {
      for (i = 0; i < merged.length; i++) {
        var m0 = merged[i].f0 * frameSec;
        var m1 = merged[i].f1 * frameSec;
        for (ti = 0; ti < p.audioTracks.length; ti++) {
          muted += eachInRange(seq.audioTracks[p.audioTracks[ti]], m0, m1, function (item) {
            /* Volume > Level: minimum of Premiere's mapped scale = silence. */
            return SC_setComponentProp(item, 'Volume', 'Level', 0);
          });
        }
        removedSegments++;
      }
    } else if (p.mode === 'gaps' || p.mode === 'ripple') {
      for (i = merged.length - 1; i >= 0; i--) {
        var s0 = merged[i].f0 * frameSec;
        var s1 = merged[i].f1 * frameSec;
        var useRipple = (p.mode === 'ripple');
        var rt = merged[i].rt;
        var ri = merged[i].ri;
        var got = 0;
        /* Non-ripple removals first, then one ripple delete closes the gap
           across all tracks. */
        for (ti = 0; ti < p.audioTracks.length; ti++) {
          if (useRipple && rt === 'audio' && ri === p.audioTracks[ti]) continue;
          got += eachInRange(seq.audioTracks[p.audioTracks[ti]], s0, s1, removeItem(false));
        }
        for (ti = 0; ti < p.videoTracks.length; ti++) {
          if (useRipple && rt === 'video' && ri === p.videoTracks[ti]) continue;
          got += eachInRange(seq.videoTracks[p.videoTracks[ti]], s0, s1, removeItem(false));
        }
        if (useRipple) {
          var rTrack = (rt === 'video') ? seq.videoTracks[ri] : seq.audioTracks[ri];
          got += eachInRange(rTrack, s0, s1, removeItem(true));
        }
        if (got > 0) {
          removedSegments++;
          savedSeconds += (s1 - s0);
        }
      }
    } else {
      /* cutonly: the razors above are the whole job */
      removedSegments = merged.length;
    }

    /* ---- polish passes ---- */

    var nameSetV = {};
    for (i = 0; i < p.videoNames.length; i++) nameSetV[p.videoNames[i]] = true;
    var nameSetA = {};
    for (i = 0; i < p.audioNames.length; i++) nameSetA[p.audioNames[i]] = true;

    var zoomed = 0;
    if (p.zoom && p.zoom.on) {
      for (ti = 0; ti < p.videoTracks.length; ti++) {
        var trk = seq.videoTracks[p.videoTracks[ti]];
        var matched = [];
        for (var ci = 0; ci < trk.clips.numItems; ci++) {
          if (nameSetV[String(trk.clips[ci].name)]) matched.push(trk.clips[ci]);
        }
        for (var mi = 0; mi < matched.length; mi++) {
          if (mi % 2 === 1) {
            if (SC_setComponentProp(matched[mi], 'Motion', 'Scale', p.zoom.scale)) zoomed++;
          }
        }
      }
    }

    var crossfades = 0;
    if (p.crossfade && p.crossfade.on) {
      var qeSeq2 = qe.project.getActiveSequence();
      crossfades = SC_applyCrossfades(qeSeq2, p.audioTracks, nameSetA, ticksPerFrame);
    }

    return SC_toJson({
      ok: true,
      mode: p.mode,
      removedSegments: removedSegments,
      savedSeconds: savedSeconds,
      blocked: blocked,
      muted: muted,
      zoomed: zoomed,
      crossfades: crossfades,
      sequenceName: String(seq.name)
    });
  } catch (e) {
    return SC_toJson({ error: 'Cutting failed: ' + e.toString() });
  }
}
