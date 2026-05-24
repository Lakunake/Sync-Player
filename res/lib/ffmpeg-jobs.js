// ffmpeg-jobs.js — FFmpeg job queue, runFfmpegJob, and HTTP route handlers
// Extracted from server.js to eliminate the monolith.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { colors, ROOT_DIR, TRACKS_DIR, MEMORY_DIR } = require('./config');
const { verifyFfmpegAuth, createFfmpegAuthHandler } = require('./security');
const { getEncoders } = require('./memory');
const {
  getFFmpegBin,
  readSourceTrackGlobal,
  prepareTargetManifestGlobal,
  buildTrackEntryGlobal,
  extractTracksForFile,
  extractAndShareTracks
} = require('./ffmpeg-tracks');
const { Demuxer, Muxer, Decoder, Encoder, HardwareContext, getVideoDuration, cleanVttFile } = require('./ffmpeg-media');

// FFmpeg Job Queue
const ffmpegJobs = []; // { id, type, filename, status, progress, error, startTime }
let ffmpegJobCounter = 0;

// Helper: Run FFmpeg Job
async function runFfmpegJob(jobId, type, params) {
  const job = ffmpegJobs.find(j => j.id === jobId);
  if (!job) return;

  job.status = 'running';
  job.startTime = Date.now();

  const safeFilename = path.basename(params.filename);
  const addSuffix = (name, suffix) => {
    const ext = path.extname(name);
    return path.join(ROOT_DIR, 'media', path.basename(name, ext) + suffix + ext);
  };

  const inputPath = path.join(ROOT_DIR, 'media', safeFilename);

  try {
    if (type === 'remux') {
      const preset = params.preset;
      let outputPath;

      if (preset === 'mp4_fast') {
        outputPath = path.join(ROOT_DIR, 'media', path.basename(safeFilename, path.extname(safeFilename)) + '-clean.mp4');
      } else if (preset === 'keep_format') {
        const ext = path.extname(safeFilename);
        outputPath = path.join(ROOT_DIR, 'media', path.basename(safeFilename, ext) + '-clean' + ext);
      } else if (preset === 'mkv_copy') {
        outputPath = path.join(ROOT_DIR, 'media', path.basename(safeFilename, path.extname(safeFilename)) + '-clean.mkv');
      } else {
        outputPath = addSuffix(safeFilename, '-fixed');
      }

      if (!Demuxer || !Muxer) throw new Error('node-av not available');

      const demuxer = await Demuxer.open(inputPath);
      const muxer = await Muxer.open(outputPath);

      const allowedStreams = new Set();
      const streamMap = {};
      for (const stream of demuxer.streams) {
        if (stream.codecpar?.type === 'video' || stream.codecpar?.type === 'audio' || stream.codecpar?.codecType === 0 || stream.codecpar?.codecType === 1) {
          const muxerStreamIdx = muxer.addStream(stream);
          allowedStreams.add(stream.index);
          streamMap[stream.index] = muxerStreamIdx;
        }
      }

      const duration = demuxer.duration > 0 ? demuxer.duration : (await getVideoDuration(inputPath)) || 1;
      let lastRemuxUpdate = Date.now();
      const AV_NOPTS_VALUE = -9223372036854775808n;

      for await (const packet of demuxer.packets()) {
        if (!packet) break;
        if (job.status === 'cancelled') break;
        if (!allowedStreams.has(packet.streamIndex)) continue;

        if (packet.pts === AV_NOPTS_VALUE && packet.dts !== AV_NOPTS_VALUE) packet.pts = packet.dts;
        if (packet.dts === AV_NOPTS_VALUE && packet.pts !== AV_NOPTS_VALUE) packet.dts = packet.pts;

        const targetStreamIdx = streamMap[packet.streamIndex];
        await muxer.writePacket(packet, targetStreamIdx);

        if (Date.now() - lastRemuxUpdate > 4000) {
          const tb = demuxer.streams[packet.streamIndex]?.timeBase;
          if (tb && typeof packet.pts === 'bigint' && packet.pts !== AV_NOPTS_VALUE) {
            const currentSeconds = Number(packet.pts) * (tb.num / tb.den);
            job.progress = Math.min(Math.max(Math.round((currentSeconds / duration) * 100), 0), 99);
            lastRemuxUpdate = Date.now();
          }
        }
      }

      await muxer.close();
      if (demuxer && demuxer.close) await demuxer.close();

      if (job.status === 'cancelled') {
        job.endTime = Date.now();
        job.duration = (job.endTime - job.startTime) / 1000;
        console.log(`[FFmpeg] Remux job ${jobId} cancelled after ${job.duration}s`);
        // Clean up partial output
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) { }
        return;
      }

      job.status = 'completed';
      job.progress = 100;
      job.endTime = Date.now();
      job.duration = (job.endTime - job.startTime) / 1000;

      try {
        await extractAndShareTracks(inputPath, safeFilename, outputPath, true, ffmpegJobs);
      } catch (e) {
        console.warn('[FFmpeg] Post-remux track extraction failed:', e.message);
      }

    } else if (type === 'reencode') {
      const { resolution, quality, encoder: encoderName } = params.options;
      const outputPath = addSuffix(safeFilename, `-${encoderName}-${resolution}-${quality}`);

      if (!Demuxer || !Muxer || !Decoder || !Encoder) throw new Error('node-av not fully loaded');

      const demuxer = await Demuxer.open(inputPath);
      const videoStream = demuxer.streams.find(s => s.codecpar.type === 'video' || s.codecpar.codecType === 0) || demuxer.video[0];
      if (!videoStream) throw new Error('No video stream found');

      const muxer = await Muxer.open(outputPath);

      let hw = null;
      if (encoderName !== 'libx264' && encoderName !== 'cpu' && HardwareContext) {
        try { hw = HardwareContext.auto(); } catch (e) { console.warn('HW Init failed', e); }
      }

      const decoder = await Decoder.create(videoStream, { hardware: hw });

      let bitrate = 4000000;
      if (quality === 'high') bitrate = 8000000;
      if (quality === 'low') bitrate = 1500000;

      const safeEncoder = (encoderName === 'auto' || encoderName === 'cpu') ? 'libx264' : encoderName;

      const encoder = await Encoder.create(safeEncoder, {
        decoder,
        bitRate: bitrate,
        timeBase: videoStream.timeBase
      });

      const outStreamIdx = muxer.addStream(encoder);
      const inputPackets = demuxer.packets(videoStream.index);
      const decodedFrames = decoder.frames(inputPackets);
      const encodedPackets = encoder.packets(decodedFrames);

      const duration = demuxer.duration > 0 ? demuxer.duration : (await getVideoDuration(inputPath)) || 1;
      let lastReencodeUpdate = Date.now();
      const AV_NOPTS_VALUE = -9223372036854775808n;

      for await (const packet of encodedPackets) {
        if (!packet) {
          await muxer.writePacket(null, outStreamIdx); break;
        }
        if (job.status === 'cancelled') break;

        if (packet.pts === AV_NOPTS_VALUE && packet.dts !== AV_NOPTS_VALUE) packet.pts = packet.dts;
        if (packet.dts === AV_NOPTS_VALUE && packet.pts !== AV_NOPTS_VALUE) packet.dts = packet.pts;

        await muxer.writePacket(packet, outStreamIdx);

        if (Date.now() - lastReencodeUpdate > 4000) {
          const tb = videoStream.timeBase;
          if (tb && typeof packet.pts === 'bigint' && packet.pts !== AV_NOPTS_VALUE) {
            const currentSeconds = Number(packet.pts) * (tb.num / tb.den);
            job.progress = Math.min(Math.max(Math.round((currentSeconds / duration) * 100), 0), 99);
            lastReencodeUpdate = Date.now();
          }
        }
      }

      await muxer.close();
      if (demuxer && demuxer.close) await demuxer.close();

      if (job.status === 'cancelled') {
        job.endTime = Date.now();
        job.duration = (job.endTime - job.startTime) / 1000;
        console.log(`[FFmpeg] Reencode job ${jobId} cancelled after ${job.duration}s`);
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) { }
        return;
      }

      job.status = 'completed';
      job.progress = 100;
      job.endTime = Date.now();
      job.duration = (job.endTime - job.startTime) / 1000;

      try {
        await extractAndShareTracks(inputPath, safeFilename, outputPath, true, ffmpegJobs);
      } catch (e) {
        console.warn('[FFmpeg] Post-reencode track extraction failed:', e.message);
      }

    } else if (type === 'extract') {
      // DEDUPLICATED: Delegates to extractTracksForFile instead of having its own copy
      const { trackType } = params.options;
      const targetFormat = params.preset;

      const tracks = await extractTracksForFile(inputPath, safeFilename, trackType, targetFormat, false, null);

      // Update job progress manually since we didn't pass ffmpegJobs to extractTracksForFile
      // (the job is this extract job itself, not a side job)
      job.status = 'completed';
      job.progress = 100;
      job.endTime = Date.now();
      job.duration = (job.endTime - job.startTime) / 1000;

      if (Demuxer) {
        const demuxer = await Demuxer.open(inputPath);
        if (demuxer && demuxer.close) await demuxer.close();
      }

    } else if (type === 'track-tool') {
      const { action, sourceVideo, targetVideo, trackIndex, orphanFile } = params.options;

      if (action === 'rebind' || action === 'share') {
        const src = readSourceTrackGlobal(sourceVideo, trackIndex);
        if (src.error) throw new Error(src.error);

        const tgt = prepareTargetManifestGlobal(targetVideo);

        if (action === 'rebind') {
          let absoluteOldPath = path.join(TRACKS_DIR, src.track.path);
          if (!fs.existsSync(absoluteOldPath) && path.isAbsolute(src.track.path) && fs.existsSync(src.track.path)) {
            absoluteOldPath = src.track.path;
          }

          const ext = path.extname(absoluteOldPath);
          const lang = src.track.lang || 'und';
          const title = (src.track.title || 'Track').replace(/[^a-zA-Z0-9]/g, '');
          const newFileName = `${tgt.safeBaseName}_track${tgt.nextIndex}_${lang}_${title}${ext}`;
          const absoluteNewPath = path.join(TRACKS_DIR, newFileName);

          await fs.promises.rename(absoluteOldPath, absoluteNewPath);

          tgt.manifest.externalTracks.push(buildTrackEntryGlobal(newFileName, {
            type: src.track.type || 'subtitle', lang, title: src.track.title || 'Track'
          }));
          await fs.promises.writeFile(tgt.manifestPath, JSON.stringify(tgt.manifest, null, 2));

          src.manifest.externalTracks.splice(src.arrayIndex, 1);
          await fs.promises.writeFile(src.manifestPath, JSON.stringify(src.manifest, null, 2));
          console.log(`[Subtitle] Rebound ${newFileName} from ${sourceVideo} to ${targetVideo}`);

        } else if (action === 'share') {
          if (tgt.manifest.externalTracks.some(t => t.path === src.track.path)) {
            throw new Error('Subtitle is already linked to target');
          }
          tgt.manifest.externalTracks.push(buildTrackEntryGlobal(src.track.path, {
            type: src.track.type || 'subtitle', lang: src.track.lang || 'und', title: src.track.title || 'Track'
          }));
          await fs.promises.writeFile(tgt.manifestPath, JSON.stringify(tgt.manifest, null, 2));
          console.log(`[Subtitle] Shared ${src.track.path} from ${sourceVideo} to ${targetVideo}`);
        }

        job.status = 'completed';
        job.progress = 100;

      } else if (action === 'bind-orphan') {
        const sourcePath = path.join(TRACKS_DIR, orphanFile);
        if (!fs.existsSync(sourcePath)) throw new Error('Orphan file not found');

        const tgt = prepareTargetManifestGlobal(targetVideo);
        let finalSourcePath = sourcePath;
        let ext = path.extname(sourcePath).toLowerCase();
        let wasConverted = false;

        if (ext === '.srt') {
          const ffBin = getFFmpegBin();
          const tempVttName = `${path.basename(orphanFile, '.srt')}_converted.vtt`;
          const tempVttPath = path.join(TRACKS_DIR, tempVttName);

          await new Promise((resolve, reject) => {
            const proc = spawn(ffBin, ['-y', '-i', sourcePath, tempVttPath]);
            proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
            proc.on('error', err => reject(err));
          });

          finalSourcePath = tempVttPath;
          ext = '.vtt';
          wasConverted = true;
          console.log(`[Subtitle] Converted SRT to VTT: ${tempVttName}`);
        }

        const newFileName = `${tgt.safeBaseName}_track${tgt.nextIndex}_und_Orphan${ext}`;
        const finalPath = path.join(TRACKS_DIR, newFileName);
        await fs.promises.rename(finalSourcePath, finalPath);

        if (wasConverted && fs.existsSync(sourcePath)) {
          try { fs.unlinkSync(sourcePath); } catch (e) { }
        }

        tgt.manifest.externalTracks.push(buildTrackEntryGlobal(newFileName, {
          type: 'subtitle', lang: 'und', title: 'Orphan'
        }));
        await fs.promises.writeFile(tgt.manifestPath, JSON.stringify(tgt.manifest, null, 2));

        job.status = 'completed';
        job.progress = 100;
      }

      job.endTime = Date.now();
      job.duration = (job.endTime - job.startTime) / 1000;

    } else {
      job.status = 'failed';
      job.error = 'Job type not implemented yet';
    }
  } catch (err) {
    console.error('Job failed:', err);
    job.status = 'failed';
    job.error = err.message;
  }
}

// ==================== HTTP Route Registration ====================
function registerFFmpegRoutes(app) {
  // Auth endpoint (honeypot)
  app.post('/api/ffmpeg/auth', express.json(), createFfmpegAuthHandler());

  // Run a preset FFmpeg job
  app.post('/api/ffmpeg/run-preset', express.json(), verifyFfmpegAuth, (req, res) => {
    const { type, filename, preset, options } = req.body;
    if (!filename) return res.status(400).json({ error: 'Filename required' });

    ffmpegJobCounter++;
    const job = {
      id: ffmpegJobCounter,
      type,
      filename,
      status: 'pending',
      progress: 0,
      startTime: Date.now(),
      preset
    };

    ffmpegJobs.push(job);
    runFfmpegJob(job.id, type, { filename, preset, options });
    res.json({ success: true, jobId: job.id });
  });

  // List jobs
  app.get('/api/ffmpeg/jobs', (req, res) => {
    const active = ffmpegJobs.filter(j => ['pending', 'running'].includes(j.status));
    const history = ffmpegJobs.filter(j => ['completed', 'failed', 'cancelled'].includes(j.status))
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, 10);
    res.json({ jobs: [...active, ...history] });
  });

  // Cancel a job
  app.post('/api/ffmpeg/cancel', express.json(), verifyFfmpegAuth, (req, res) => {
    const { jobId } = req.body;
    const job = ffmpegJobs.find(j => j.id === parseInt(jobId));
    if (job && job.status === 'running') {
      job.status = 'cancelled';
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Job not found or not running' });
    }
  });

  // List available encoders
  app.get('/api/ffmpeg/encoders', (req, res) => {
    let encoders = getEncoders();
    if (encoders && encoders.length > 0) {
      // Map objects to strings for the frontend
      encoders = encoders.filter(e => e.type === 'video').map(e => e.name);
      if (!encoders.includes('cpu')) encoders.unshift('cpu');
    } else {
      // Fallback if detection hasn't finished or failed
      encoders = ['cpu', 'libx264', 'libx265'];
      if (HardwareContext) {
        encoders.push('h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_amf', 'h264_qsv', 'hevc_qsv');
      }
    }
    res.json({ encoders });
  });
}

module.exports = {
  ffmpegJobs,
  runFfmpegJob,
  registerFFmpegRoutes
};
