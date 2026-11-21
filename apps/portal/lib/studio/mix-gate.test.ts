import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIO_MIX_CAPABILITY, CAPTION_STYLE_CAPABILITY, mixFeaturesFor, renderJobCapability } from "./render-gate.ts";

test("audio and captionStyle are sent only when every render worker reports the capability that honours them", () => {
  const v07 = ["echo", "ffmpeg", "xfade", "narration-tempo", AUDIO_MIX_CAPABILITY, CAPTION_STYLE_CAPABILITY];
  const v06 = ["echo", "ffmpeg", "xfade", "narration-tempo"];
  assert.deepEqual(mixFeaturesFor([v07]), { audio: true, captionStyle: true, note: null });
  assert.deepEqual(mixFeaturesFor([v07, ["echo", "tts-kokoro"]]), { audio: true, captionStyle: true, note: null }, "a worker that cannot render does not matter");
  // An older render worker could claim the job and ignore both, so neither is sent, and the run says so.
  const mixed = mixFeaturesFor([v07, v06]);
  assert.equal(mixed.audio, false);
  assert.equal(mixed.captionStyle, false);
  assert.match(mixed.note ?? "", /without music, ambience and the mastered loudness and the measured caption style: every render worker must be 0.7.0 or later/);
  // A worker whose ffmpeg lacks a mix filter reports caption-style but not audio-mix.
  const noMix = mixFeaturesFor([[...v06, CAPTION_STYLE_CAPABILITY]]);
  assert.deepEqual([noMix.audio, noMix.captionStyle], [false, true]);
  assert.match(noMix.note ?? "", /without music, ambience and the mastered loudness:/);
  // Unknown or none enrolled: the 0.6.0 payload, so the bed's licence is never listed for a video without it.
  for (const lists of [null, [], [["echo"]]]) {
    const f = mixFeaturesFor(lists);
    assert.deepEqual([f.audio, f.captionStyle], [false, false]);
    assert.match(f.note ?? "", /no render worker has reported/);
  }
  // The job's own capability is unchanged by the mix: engines and fades decide who may claim it.
  assert.equal(renderJobCapability("ffmpeg-stills", 0), "ffmpeg");
  assert.equal(renderJobCapability("ffmpeg-stills", 0.5), "xfade");
});
