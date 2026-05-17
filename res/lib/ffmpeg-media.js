// ffmpeg-media.js — Thumbnails, VTT cleaning, duration, fonts, encoder detection
// Extracted from server.js to eliminate the monolith.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, exec } = require('child_process');
const { colors, ROOT_DIR, MEMORY_DIR, MEDIA_DIR, THUMBNAIL_DIR } = require('./config');
const { getFFmpegBin } = require('./ffmpeg-tracks');

// node-av imports
let HardwareContext, Demuxer, Muxer, Decoder, Encoder, FilterAPI;
try {
  const avApi = require('node-av/api');
  HardwareContext = avApi.HardwareContext;
  Demuxer = avApi.Demuxer;
  Muxer = avApi.Muxer;
  Decoder = avApi.Decoder;
  Encoder = avApi.Encoder;
  FilterAPI = avApi.FilterAPI;
} catch (e) {
  console.warn(`${colors.yellow}node-av not found or failed to load. FFmpeg features disabled.${colors.reset}`, e.message);
}

// Get video duration using node-av
async function getVideoDuration(videoPath) {
  let demuxer = null;
  try {
    if (Demuxer) {
      demuxer = await Demuxer.open(videoPath);
      return demuxer.duration || 0;
    } else {
      return new Promise((resolve, reject) => {
        execFile('ffprobe', [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format',
          videoPath
        ], (error, stdout) => {
          if (error) { reject(error); return; }
          try {
            const data = JSON.parse(stdout);
            resolve(parseFloat(data.format.duration) || 0);
          } catch (e) { reject(e); }
        });
      });
    }
  } catch (err) {
    console.error(`Error getting duration for ${videoPath}:`, err.message);
    return 0;
  } finally {
    if (demuxer) await demuxer.close();
  }
}

// Post-process generated VTT file to remove duplicate cues and ASS artifacts
async function cleanVttFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;

    const content = await fs.promises.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    const cleanLines = [];
    if (lines.length > 0 && lines[0].startsWith('WEBVTT')) {
      cleanLines.push(lines[0]);
      cleanLines.push('');
    }

    let i = 0;
    let lastCue = null;

    while (i < lines.length) {
      let line = lines[i];

      if (line.includes('-->')) {
        const parts = line.split(' --> ');
        if (parts.length >= 2) {
          const start = parts[0].trim();
          const end = parts[1].trim();

          let payload = [];
          let j = i + 1;
          while (j < lines.length && lines[j].trim() !== '') {
            const txt = lines[j].trim();
            if (!/^m\s+-?\d+/.test(txt)) {
              payload.push(lines[j]);
            }
            j++;
          }

          if (payload.length > 0) {
            const payloadText = payload.join('\n');
            let isDuplicate = false;
            if (lastCue && lastCue.start === start && lastCue.end === end && lastCue.text === payloadText) {
              isDuplicate = true;
            }

            if (!isDuplicate) {
              cleanLines.push(`${start} --> ${end}`);
              cleanLines.push(...payload);
              cleanLines.push('');
              lastCue = { start, end, text: payloadText };
            }
          }

          i = j;
          continue;
        }
      }
      i++;
    }

    const newContent = cleanLines.join('\n');
    await fs.promises.writeFile(filePath, newContent, 'utf8');
    console.log(`[VTT-Clean] Processed ${path.basename(filePath)} (removed artifacts/duplicates)`);
  } catch (e) {
    console.error(`[VTT-Clean] Error processing ${path.basename(filePath)}:`, e);
  }
}

// --- Thumbnail Helper Functions ---

async function generateAudioCoverArt(videoPath, thumbnailPath) {
  let input = null;
  try {
    if (!Demuxer) throw new Error('node-av Demuxer not available');

    console.log(`${colors.cyan}Processing audio cover art with node-av for: ${path.basename(videoPath)}${colors.reset}`);
    input = await Demuxer.open(videoPath);
    let coverStream = null;

    for (const stream of input.streams) {
      if (stream.disposition & 1024) { coverStream = stream; break; }
    }
    if (!coverStream) {
      for (const stream of input.streams) {
        if (stream.codecpar && (stream.codecpar.codecType === 0 || stream.codecpar.type === 'video')) {
          coverStream = stream; break;
        }
      }
    }

    if (coverStream) {
      console.log(`${colors.cyan}Found cover art stream #${coverStream.index}. Extracting...${colors.reset}`);
      let found = false;
      for await (const packet of input.packets(coverStream.index)) {
        if (packet.streamIndex === coverStream.index) {
          if (packet.data && packet.data.length > 0) {
            const bytes = packet.data;
            const isPng  = bytes[0] === 0x89 && bytes[1] === 0x50;
            const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8;
            const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;

            let actualExt = '.jpg';
            if (isPng) actualExt = '.png';
            else if (isWebp) actualExt = '.webp';
            else if (!isJpeg) {
              console.warn(`${colors.yellow}[CoverArt] Unknown image magic bytes, writing anyway${colors.reset}`);
            }

            const actualPath = thumbnailPath.replace(/\.jpg$/, actualExt);
            fs.writeFileSync(actualPath, bytes);

            const stat = fs.statSync(actualPath);
            if (stat.size === 0) {
              fs.unlinkSync(actualPath);
              console.warn(`${colors.yellow}[CoverArt] Zero-byte cover art written, discarding${colors.reset}`);
              packet.free();
              break;
            }

            console.log(`${colors.green}Extracted cover art to: ${actualPath}${colors.reset}`);
            found = true;
          }
          packet.free();
          break;
        }
        packet.free();
      }
      return found;
    }
    return false;
  } catch (err) {
    console.error(`${colors.red}Error extracting audio cover art: ${err.message}${colors.reset}`);
    return false;
  } finally {
    if (input && typeof input.close === 'function') await input.close();
  }
}

async function generateThumbnailNodeAv(videoPath, thumbnailPath, width, safeFilename) {
  if (!Demuxer || !Decoder || !Encoder || !FilterAPI || !Muxer) return false;

  let input = null;
  let output = null;
  try {
    console.log(`${colors.cyan}Processing thumbnail with node-av for: ${safeFilename}${colors.reset}`);

    const masterFilename = safeFilename.replace(/\.[^.]+$/, '.jpg');
    const masterPath = path.join(THUMBNAIL_DIR, masterFilename);
    let inputPath = videoPath;
    let isImageInput = false;

    if (width !== 720 && fs.existsSync(masterPath)) {
      const masterStat = fs.statSync(masterPath);
      if (masterStat.size > 0) {
        inputPath = masterPath;
        isImageInput = true;
        console.log(`${colors.cyan}Downscaling existing master thumbnail for ${safeFilename}${colors.reset}`);
      }
    }

    input = await Demuxer.open(inputPath);
    const videoStream = input.video();
    if (!videoStream) throw new Error('No video stream found');

    if (!isImageInput) {
      const duration = input.duration > 0 ? input.duration : (await getVideoDuration(videoPath));
      const seed = safeFilename.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const seekPct = Math.max(0.01, (seed % 20) / 100);
      const seekTime = Math.max(1, Math.floor(duration * seekPct));
      console.log(`${colors.cyan}Seeking deterministically to ${seekTime}s (duration: ${duration}s)${colors.reset}`);
      try { await input.seek(seekTime); } catch (seekErr) {
        console.warn(`${colors.yellow}[Thumbnail] Seek failed, reading from start: ${seekErr.message}${colors.reset}`);
      }
    }

    const decoder = await Decoder.create(videoStream);
    output = await Muxer.open(thumbnailPath, { format: 'image2', update: '1' });

    const packetGen = input.packets(videoStream.index);
    const frameGen = decoder.frames(packetGen);

    let gotFrame = false;
    let encoder = null;
    let outStreamIdx = -1;

    for await (const frame of frameGen) {
      if (!gotFrame) {
        const filter = await FilterAPI.create(`scale=-2:${width},format=yuv420p`, {
          width: frame.width, height: frame.height,
          pixelFormat: frame.format, timeBase: videoStream.timeBase
        });

        const filteredFrames = await filter.processAll(frame);
        for (const filteredFrame of filteredFrames) {
          if (!encoder) {
            const { FF_ENCODER_MJPEG } = require('node-av/constants');
            encoder = await Encoder.create(FF_ENCODER_MJPEG, {
              timeBase: { num: 1, den: 1 },
              width: filteredFrame.width, height: filteredFrame.height,
              pixelFormat: filteredFrame.format
            });
            outStreamIdx = output.addStream(encoder);
          }
          const packets = await encoder.encodeAll(filteredFrame);
          for (const pkt of packets) await output.writePacket(pkt, outStreamIdx);
        }

        if (encoder) {
          for await (const pkt of encoder.flushPackets()) await output.writePacket(pkt, outStreamIdx);
        }
        gotFrame = true;
        break;
      }
    }

    if (output && typeof output.close === 'function') { await output.close(); output = null; }

    if (gotFrame) {
      try {
        const stat = fs.statSync(thumbnailPath);
        if (stat.size === 0) {
          fs.unlinkSync(thumbnailPath);
          console.warn(`${colors.yellow}[Thumbnail] node-av wrote a 0-byte thumbnail, discarding${colors.reset}`);
          return false;
        }
      } catch (_) { return false; }
      console.log(`${colors.green}Generated thumbnail via node-av for: ${safeFilename}${colors.reset}`);
      return true;
    }
    return false;
  } catch (avError) {
    console.error(`${colors.yellow}node-av thumbnail failed:${colors.reset}`, avError.message);
    try { if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath); } catch (_) {}
    return false;
  } finally {
    if (output && typeof output.close === 'function') { try { await output.close(); } catch (_) {} }
    if (input && typeof input.close === 'function') await input.close();
  }
}

async function generateThumbnailFfmpeg(videoPath, thumbnailPath, width, safeFilename) {
  const duration = await getVideoDuration(videoPath);
  const firstThird = Math.max(duration / 3, 1);
  const randomTime = Math.random() * firstThird;
  const seekTime = Math.max(1, Math.floor(randomTime));

  console.log(`${colors.cyan}Generating ${width}px thumbnail for ${safeFilename} at ${seekTime}s${colors.reset}`);

  const scaleFilter = `scale=-2:${width}`;

  const runFfmpeg = (ssTime) => new Promise((resolve, reject) => {
    execFile(getFFmpegBin(), [
      '-ss', String(ssTime), '-i', videoPath,
      '-vframes', '1', '-vf', scaleFilter,
      '-q:v', '2', '-y', thumbnailPath
    ], (error) => {
      if (error) return reject(error);
      try {
        const stat = fs.statSync(thumbnailPath);
        if (stat.size === 0) {
          try { fs.unlinkSync(thumbnailPath); } catch (_) {}
          return reject(new Error('FFmpeg produced a 0-byte thumbnail'));
        }
      } catch (_) { return reject(new Error('Thumbnail file missing after FFmpeg completed')); }
      resolve();
    });
  });

  try {
    await runFfmpeg(seekTime);
    console.log(`${colors.green}Generated thumbnail for: ${safeFilename}${colors.reset}`);
  } catch (firstErr) {
    console.warn(`${colors.yellow}[Thumbnail] FFmpeg seek to ${seekTime}s failed, retrying at 1s: ${firstErr.message}${colors.reset}`);
    await runFfmpeg(1);
    console.log(`${colors.green}Generated thumbnail (fallback) for: ${safeFilename}${colors.reset}`);
  }
}

// Font extraction helpers
const fontHashCache = new Map();

async function getFontHash(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    const filename = path.basename(filePath);
    const cached = fontHashCache.get(filename);
    if (cached && cached.mtimeMs === stats.mtimeMs) return cached.hash;

    const content = await fs.promises.readFile(filePath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    fontHashCache.set(filename, { mtimeMs: stats.mtimeMs, hash });
    return hash;
  } catch (e) { return null; }
}

async function extractFonts(videoFilename) {
  if (!videoFilename) return;
  const videoPath = path.join(MEDIA_DIR, videoFilename);
  if (!fs.existsSync(videoPath)) return;

  const fontDir = path.join(path.dirname(THUMBNAIL_DIR), '..', 'font');
  if (!fs.existsSync(fontDir)) fs.mkdirSync(fontDir, { recursive: true });

  let demuxer = null;
  try {
    if (Demuxer) {
      demuxer = await Demuxer.open(videoPath);

      const existingFiles = await fs.promises.readdir(fontDir);
      const existingHashes = new Set();
      for (const file of existingFiles) {
        if (/\.(ttf|otf|woff|woff2)$/i.test(file)) {
          const hash = await getFontHash(path.join(fontDir, file));
          if (hash) existingHashes.add(hash);
        }
      }

      for (const stream of demuxer.streams) {
        const isAttachment = stream.codecpar?.codecType === 4 || stream.type === 'attachment';
        if (isAttachment) {
          const metadata = stream.metadata?.getAll?.() || {};
          const filename = metadata.filename || stream.codecpar?.extradata?.filename;
          if (filename && /\.(ttf|otf)$/i.test(filename)) {
            const packetGen = demuxer.packets(stream.index);
            const next = await packetGen.next();
            if (!next.done && next.value) {
              const packet = next.value;
              if (packet.data) {
                const fontBuffer = Buffer.from(packet.data);
                const fontHash = crypto.createHash('sha256').update(fontBuffer).digest('hex');
                if (existingHashes.has(fontHash)) {
                  console.log(`[FontExtract] Skipping ${filename} - identical font content already exists`);
                } else {
                  const safeFontName = path.basename(filename);
                  const outputPath = path.join(fontDir, safeFontName);
                  console.log(`[FontExtract] Extracting new font content: ${safeFontName}`);
                  await fs.promises.writeFile(outputPath, fontBuffer);
                  existingHashes.add(fontHash);
                  const stats = await fs.promises.stat(outputPath);
                  fontHashCache.set(safeFontName, { mtimeMs: stats.mtimeMs, hash: fontHash });
                }
              }
              packet.free();
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[FontExtract] Error processing ${videoFilename}:`, err.message);
  } finally {
    if (demuxer && typeof demuxer.close === 'function') await demuxer.close();
  }
}

// Encoder detection
function detectEncoders() {
  const memoryPath = path.join(MEMORY_DIR, 'memory.json');
  let memData = {};
  if (fs.existsSync(memoryPath)) {
    try { memData = JSON.parse(fs.readFileSync(memoryPath, 'utf8')); } catch (e) {}
  }
  if (memData.encoders && Array.isArray(memData.encoders) && memData.encoders.length > 0) return;

  let ffBin = 'ffmpeg';
  try {
    const { ffmpegPath: getFfmpegPath } = require('node-av/ffmpeg');
    const bundledPath = getFfmpegPath();
    if (bundledPath) ffBin = bundledPath;
  } catch (e) {
    const bundledManual = path.join(__dirname, '..', 'node_modules', 'node-av', 'binary', 'ffmpeg.exe');
    if (fs.existsSync(bundledManual)) ffBin = bundledManual;
  }

  exec(`"${ffBin}" -encoders`, (error, stdout) => {
    if (error) { console.error('[FFmpeg] Failed to detect encoders:', error); return; }
    const encoders = [];
    const regex = /^\s*([V A S])[A-Z.]+\s+([a-zA-Z0-9_-]+)\s+(.*)$/;
    stdout.split('\n').forEach(line => {
      const match = line.match(regex);
      if (match) {
        encoders.push({
          type: match[1] === 'V' ? 'video' : (match[1] === 'A' ? 'audio' : 'subtitle'),
          name: match[2], description: match[3].trim()
        });
      }
    });
    memData.encoders = encoders;
    try {
      if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
      fs.writeFileSync(memoryPath, JSON.stringify(memData, null, 2));
    } catch (e) { console.error('[FFmpeg] Failed to save encoders:', e); }
  });
}

// Export node-av references for use in ffmpeg-jobs.js
module.exports = {
  // node-av references
  get HardwareContext() { return HardwareContext; },
  get Demuxer() { return Demuxer; },
  get Muxer() { return Muxer; },
  get Decoder() { return Decoder; },
  get Encoder() { return Encoder; },
  get FilterAPI() { return FilterAPI; },
  // Functions
  getVideoDuration,
  cleanVttFile,
  generateAudioCoverArt,
  generateThumbnailNodeAv,
  generateThumbnailFfmpeg,
  getFontHash,
  extractFonts,
  detectEncoders
};
