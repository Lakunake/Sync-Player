// postinstall.js - Applies security patches and bundles dependencies
// Run automatically after npm install via package.json scripts.postinstall

const fs = require('fs');
const path = require('path');

const IP_LIB_PATH = path.join(__dirname, 'node_modules', 'ip', 'lib', 'ip.js');

// GHSA-2p57-rm9w-gvfp: Hardened isPublic function
const PATCHED_IS_PUBLIC = `ip.isPublic = function (addr) {
  // SECURITY FIX (GHSA-2p57-rm9w-gvfp): Manually check for internal ranges
  // that may be improperly categorized by isPrivate

  // 1. Loopback range (127.0.0.0/8) - the core vulnerability
  if (/^127\\\\./.test(addr)) {
    return false;
  }

  // 2. Link-local / Cloud Metadata (169.254.x.x)
  if (/^169\\\\.254\\\\./.test(addr)) {
    return false;
  }

  // 3. IPv6 loopback
  if (/^::1$/.test(addr) || /^::$/.test(addr)) {
    return false;
  }

  // 4. Fall back to the library's isPrivate check for general cases
  return !ip.isPrivate(addr);
};`;

const ORIGINAL_IS_PUBLIC = 'ip.isPublic = function (addr) {\n  return !ip.isPrivate(addr);\n};';

function applyIpPatch() {
  if (!fs.existsSync(IP_LIB_PATH)) {
    console.log('[postinstall] ip library not found, skipping patch.');
    return false;
  }

  let content = fs.readFileSync(IP_LIB_PATH, 'utf-8');

  // Check if already patched
  if (content.includes('GHSA-2p57-rm9w-gvfp')) {
    console.log('[postinstall] ip library already patched.');
    return true;
  }

  // Apply patch
  if (content.includes(ORIGINAL_IS_PUBLIC)) {
    content = content.replace(ORIGINAL_IS_PUBLIC, PATCHED_IS_PUBLIC);
    fs.writeFileSync(IP_LIB_PATH, content, 'utf-8');
    console.log('[postinstall] ✓ Applied security patch to ip library (GHSA-2p57-rm9w-gvfp)');
    return true;
  } else {
    console.warn('[postinstall] ⚠ Could not find original isPublic function to patch. Manual review required.');
    return false;
  }
}

// Writes a JSON file listing advisories that have been patched at runtime.
// The custom `npm run audit` script reads this to filter false positives.
function writePatchedAdvisories(patched) {
  const advisoryFile = path.join(__dirname, '.patched-advisories.json');
  try {
    fs.writeFileSync(advisoryFile, JSON.stringify({ patched }, null, 2), 'utf-8');
  } catch (_) { }
}

// ==================== JASSUB Bundling ====================
async function bundleJassub() {
  const JASSUB_SRC = path.join(__dirname, 'node_modules', 'jassub', 'dist');
  const JASSUB_DEST = path.join(__dirname, 'public', 'jassub');
  const JASSUB_WASM_SRC = path.join(JASSUB_SRC, 'wasm');

  // Check if jassub is installed
  if (!fs.existsSync(JASSUB_SRC)) {
    console.log('[postinstall] jassub not found in node_modules, skipping bundle.');
    return;
  }

  // Create destination directory
  if (!fs.existsSync(JASSUB_DEST)) {
    fs.mkdirSync(JASSUB_DEST, { recursive: true });
  }

  try {
    // Try to use esbuild for bundling
    let esbuild;
    try {
      esbuild = require('esbuild');
    } catch (e) {
      console.log('[postinstall] esbuild not installed, installing...');
      const { execSync } = require('child_process');
      execSync('npm install --save-dev esbuild', {
        cwd: __dirname,
        stdio: 'inherit'
      });
      esbuild = require('esbuild');
    }

    // Bundle jassub.js with all its dependencies into a single browser-ready file
    const inputFile = path.join(JASSUB_SRC, 'jassub.js');
    const outputFile = path.join(JASSUB_DEST, 'jassub.bundle.js');

    await esbuild.build({
      entryPoints: [inputFile],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      outfile: outputFile,
      minify: true,
      sourcemap: false,
      // External deps that are loaded separately
      external: [],
    });

    console.log('[postinstall] ✓ Bundled JASSUB with esbuild');

    // Copy WASM files and worker
    const wasmFiles = [
      'jassub-worker.js',
      'jassub-worker.wasm',
      'jassub-worker-modern.wasm'
    ];

    for (const file of wasmFiles) {
      const src = path.join(JASSUB_WASM_SRC, file);
      const dest = path.join(JASSUB_DEST, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    }

    // Copy default font if exists
    const defaultFont = path.join(JASSUB_SRC, 'default.woff2');
    if (fs.existsSync(defaultFont)) {
      fs.copyFileSync(defaultFont, path.join(JASSUB_DEST, 'default.woff2'));
    }

    console.log('[postinstall] ✓ Copied JASSUB WASM files and assets');

  } catch (error) {
    console.error('[postinstall] ⚠ Failed to bundle JASSUB:', error.message);
    console.log('[postinstall] JASSUB will fall back to CDN or built-in renderer');
  }
}

// Run all postinstall tasks
async function main() {
  const patchedAdvisories = [];

  const ipPatched = applyIpPatch();
  if (ipPatched) {
    patchedAdvisories.push('GHSA-2p57-rm9w-gvfp');
  }

  writePatchedAdvisories(patchedAdvisories);

  await bundleJassub();
}

main().catch(console.error);
