// ffmpeg-tracks.js — Track manifest helpers and extraction logic
// Extracted from server.js to eliminate the monolith.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { colors, TRACKS_DIR, TRACKS_MANIFEST_DIR, ROOT_DIR } = require('./config');

// node-av imports
let Demuxer;
try {
  const avApi = require('node-av/api');
  Demuxer = avApi.Demuxer;
} catch (e) { /* handled in ffmpeg-media */ }

// node-av ffmpeg binary path
let ffmpegPath, isFfmpegAvailable;
try {
  const navFfmpeg = require('node-av/ffmpeg');
  ffmpegPath = navFfmpeg.ffmpegPath;
  isFfmpegAvailable = navFfmpeg.isFfmpegAvailable;
} catch (e) { /* fallback below */ }

function getFFmpegBin() {
  if (typeof isFfmpegAvailable === 'function' && isFfmpegAvailable()) {
    return ffmpegPath();
  }
  return 'ffmpeg';
}

// =================================================================
// Track Manifest Helpers
// =================================================================
function readSourceTrackGlobal(videoFile, trackIdx) {
  const manifestName = path.basename(videoFile) + '.json';
  const manifestPath = path.join(TRACKS_MANIFEST_DIR, manifestName);

  if (!fs.existsSync(manifestPath)) {
    return { error: 'Source video does not have a track manifest.' };
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const externalTracks = manifest.externalTracks || [];
    const arrayIndex = trackIdx >= 1000 ? trackIdx - 1000 : parseInt(trackIdx);
    const track = externalTracks[arrayIndex];

    if (!track) {
      return { error: `Specified track does not exist in the source manifest (tried index ${arrayIndex}).` };
    }

    return { manifest, manifestPath, track, arrayIndex };
  } catch (e) {
    return { error: 'Failed to parse source manifest: ' + e.message };
  }
}

function prepareTargetManifestGlobal(targetVideo) {
  const manifestName = path.basename(targetVideo) + '.json';
  const manifestPath = path.join(TRACKS_MANIFEST_DIR, manifestName);
  let manifest = { externalTracks: [] };

  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { }
  }
  if (!manifest.externalTracks) manifest.externalTracks = [];

  let maxIndex = -1;
  manifest.externalTracks.forEach(t => {
    if (t.path) {
      const match = t.path.match(/_track(\d+)_/);
      if (match) {
        const idx = parseInt(match[1]);
        if (idx > maxIndex) maxIndex = idx;
      }
    }
  });

  return {
    manifest,
    manifestPath,
    nextIndex: maxIndex + 1,
    safeBaseName: path.basename(targetVideo).replace(/\.[^/.]+$/, '')
  };
}

function buildTrackEntryGlobal(trackPath, opts = {}) {
  return {
    type: opts.type || 'subtitle',
    lang: opts.lang || 'und',
    title: opts.title || 'Track',
    isExternal: true,
    path: trackPath,
    url: `/tracks/${trackPath}`
  };
}

// =================================================================
// Extract tracks from a video file (reusable helper)
// =================================================================
async function extractTracksForFile(inputPath, safeFilename, trackType, targetFormat, isSideJob = false, ffmpegJobs = null) {
  if (!Demuxer) throw new Error('node-av Demuxer not available');

  const demuxer = await Demuxer.open(inputPath);
  const extractedTracks = [];

  try {
    let matchingStreams = [];
    if (trackType === 'audio') {
      matchingStreams = demuxer.streams.filter(s => s.codecpar?.type === 'audio' || s.codecpar?.codecType === 1);
    } else {
      matchingStreams = demuxer.streams.filter(s => s.codecpar?.type === 'subtitle' || s.codecpar?.codecType === 3);
    }

    if (matchingStreams.length === 0) return extractedTracks;

    let job = null;
    if (isSideJob && ffmpegJobs) {
      const jobId = 'extract_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      job = {
        id: jobId,
        type: trackType === 'subtitle' ? 'extract-sub' : 'extract-audio',
        filename: safeFilename,
        status: 'running',
        progress: 0,
        startTime: Date.now()
      };
      ffmpegJobs.push(job);
    }

    const originalExt = path.extname(safeFilename);
    const baseName = path.basename(safeFilename, originalExt);

    let ext = targetFormat;
    if (trackType === 'subtitle') {
      ext = (targetFormat === 'ass') ? 'ass' : 'vtt';
    } else if (trackType === 'audio' && targetFormat === 'aac') {
      ext = 'm4a';
    }

    for (let i = 0; i < matchingStreams.length; i++) {
      const stream = matchingStreams[i];
      const meta = stream.metadata?.getAll?.() || {};
      const lang = meta.language || 'und';
      const title = meta.title || meta.handler_name || (trackType === 'audio' ? `Audio Track ${stream.index}` : `Subtitle Track ${stream.index}`);
      const safeTitle = title.replace(/[^a-zA-Z0-9_\-\.]/g, '_').substring(0, 50);

      const outputFilename = `${baseName}_track${stream.index}_${lang}_${safeTitle}.${ext}`;
      const outputUrl = path.join(TRACKS_DIR, outputFilename);

      // Skip if already extracted
      if (fs.existsSync(outputUrl)) {
        console.log(`[FFmpeg] Track already exists, skipping: ${outputFilename}`);
        extractedTracks.push({ path: outputFilename, type: trackType, lang, title });

        if (job) {
          job.progress = Math.round(((i + 1) / matchingStreams.length) * 100);
          if (i === matchingStreams.length - 1) {
            job.status = 'completed';
            job.endTime = Date.now();
            job.duration = (job.endTime - job.startTime) / 1000;
          }
        }
        continue;
      }

      console.log(`[FFmpeg] Extracting stream ${stream.index} (${lang}) to: ${outputUrl}`);

      const args = ['-i', inputPath, '-map', `0:${stream.index}`, '-y'];

      if (trackType === 'audio') {
        if (targetFormat === 'mp3') {
          args.push('-c:a', 'libmp3lame', '-q:a', '2');
        } else if (targetFormat === 'aac' || targetFormat === 'm4a') {
          args.push('-f', 'mp4', '-movflags', '+faststart');
          if (stream.codec_name === 'aac') {
            args.push('-c:a', 'copy');
          } else {
            args.push('-c:a', 'aac', '-b:a', '192k');
          }
        } else if (targetFormat === 'flac') {
          args.push('-c:a', 'flac');
        } else {
          args.push('-c:a', 'copy');
        }
      } else {
        if (ext === 'ass') {
          args.push('-c:s', 'ass');
        } else {
          args.push('-c:s', 'webvtt');
        }
      }

      args.push(outputUrl);

      const { getVideoDuration } = require('./ffmpeg-media');
      const totalDuration = await getVideoDuration(inputPath);
      let lastExtractUpdate = Date.now();

      await new Promise((resolve, reject) => {
        const proc = spawn(getFFmpegBin(), args);

        proc.stderr.on('data', (data) => {
          if (!job) return;
          if (Date.now() - lastExtractUpdate < 3000) return;

          const text = data.toString();
          const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.\d{2}/);
          if (timeMatch && totalDuration > 0) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            const seconds = parseInt(timeMatch[3], 10);
            const elapsed = (hours * 3600) + (minutes * 60) + seconds;

            const baseProgress = (i / matchingStreams.length) * 100;
            const chunkProgress = (elapsed / totalDuration) * (100 / matchingStreams.length);
            job.progress = Math.min(Math.round(baseProgress + chunkProgress), 100);
            lastExtractUpdate = Date.now();
          }
        });

        proc.on('close', async (code) => {
          if (code === 0) {
            if (targetFormat === 'vtt' || ext === 'vtt') {
              const { cleanVttFile } = require('./ffmpeg-media');
              await cleanVttFile(outputUrl);
            }
            if (job) {
              job.progress = Math.round(((i + 1) / matchingStreams.length) * 100);
              if (i === matchingStreams.length - 1) {
                job.status = 'completed';
                job.endTime = Date.now();
                job.duration = (job.endTime - job.startTime) / 1000;
              }
            }
            resolve();
          } else {
            if (job) {
              job.status = 'error';
              job.error = `FFmpeg exited with code ${code}`;
              job.endTime = Date.now();
            }
            reject(new Error(`FFmpeg exited with code ${code}`));
          }
        });
        proc.on('error', (err) => reject(err));
      });

      // Update manifest for the source video
      try {
        const manifestFilename = safeFilename + '.json';
        const manifestPath = path.join(TRACKS_MANIFEST_DIR, manifestFilename);
        let manifest = { externalTracks: [] };

        if (fs.existsSync(manifestPath)) {
          try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { }
        }

        const existingIdx = manifest.externalTracks.findIndex(t => t.path === outputFilename);
        const newTrack = buildTrackEntryGlobal(outputFilename, { type: trackType, lang, title });

        if (existingIdx >= 0) {
          manifest.externalTracks[existingIdx] = newTrack;
        } else {
          manifest.externalTracks.push(newTrack);
        }

        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      } catch (e) {
        console.error('Failed to update manifest:', e);
      }

      extractedTracks.push({ path: outputFilename, type: trackType, lang, title });
    }
  } finally {
    if (demuxer && typeof demuxer.close === 'function') {
      await demuxer.close();
    }
  }

  return extractedTracks;
}

// =================================================================
// Post-completion: Extract all tracks from original and share to output
// =================================================================
async function extractAndShareTracks(inputPath, safeFilename, outputPath, isSideJob = false, ffmpegJobs = null) {
  const outputFilename = path.basename(outputPath);
  console.log(`[FFmpeg] Auto-extracting tracks from ${safeFilename} and sharing to ${outputFilename}...`);

  let allTracks = [];

  try {
    const subTracks = await extractTracksForFile(inputPath, safeFilename, 'subtitle', 'vtt', isSideJob, ffmpegJobs);
    allTracks = allTracks.concat(subTracks);
  } catch (e) {
    console.warn('[FFmpeg] Subtitle extraction skipped:', e.message);
  }

  try {
    const audioTracks = await extractTracksForFile(inputPath, safeFilename, 'audio', 'aac', isSideJob, ffmpegJobs);
    allTracks = allTracks.concat(audioTracks);
  } catch (e) {
    console.warn('[FFmpeg] Audio extraction skipped:', e.message);
  }

  if (allTracks.length === 0) {
    console.log(`[FFmpeg] No tracks found to share with ${outputFilename}`);
    return;
  }

  const tgt = prepareTargetManifestGlobal(outputFilename);

  for (const track of allTracks) {
    if (tgt.manifest.externalTracks.some(t => t.path === track.path)) {
      continue;
    }
    tgt.manifest.externalTracks.push(buildTrackEntryGlobal(track.path, {
      type: track.type,
      lang: track.lang,
      title: track.title
    }));
  }

  fs.writeFileSync(tgt.manifestPath, JSON.stringify(tgt.manifest, null, 2));
  console.log(`[FFmpeg] Shared ${allTracks.length} tracks to ${outputFilename}`);
}

module.exports = {
  getFFmpegBin,
  readSourceTrackGlobal,
  prepareTargetManifestGlobal,
  buildTrackEntryGlobal,
  extractTracksForFile,
  extractAndShareTracks
};
