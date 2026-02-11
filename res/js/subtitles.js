class SubtitleRenderer {
    constructor(videoElement, overlayElement) {
        this.video = videoElement;
        this.overlay = overlayElement;
        this.cues = [];
        this.activeCues = [];
        this.format = 'vtt'; // 'vtt' or 'ass'
        this.assParams = { playResX: 384, playResY: 288 }; // Default ASS resolution
        this.styles = {}; // Map of style names to style objects
        this.isEnabled = false;

        // Bind methods
        this.update = this.update.bind(this);
        this.resize = this.resize.bind(this);
    }

    async loadTrack(url, format = 'vtt') {
        try {
            console.log(`[SubtitleRenderer] Fetching: ${url}`);
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch track');
            const text = await res.text();

            this.format = format;
            this.cues = [];
            this.styles = {};

            if (format === 'ass') {
                this.parseASS(text);
            } else {
                this.parseVTT(text);
            }

            this.isEnabled = true;
            this.update(); // Initial render
            this.resize(); // Initial resize
            console.log(`[Subtitle] Loaded ${this.cues.length} cues (${format})`);
            // Optional: Dispatch event or call global showTemporaryMessage if available
            if (typeof showTemporaryMessage === 'function') {
                showTemporaryMessage(`Subtitles loaded: ${this.cues.length} lines`, 3000);
            }
        } catch (e) {
            console.error('[Subtitle] Error loading track:', e);
            this.disable();
        }
    }

    disable() {
        this.isEnabled = false;
        this.cues = [];
        this.activeCues = [];
        this.overlay.innerHTML = '';
    }

    parseVTT(text) {
        const lines = text.split(/\r?\n/);
        let i = 0;

        // Skip header
        if (lines[0].startsWith('WEBVTT')) i++;

        while (i < lines.length) {
            let line = lines[i].trim();

            // Skip empty lines or notes
            if (!line || line.startsWith('NOTE')) {
                i++;
                continue;
            }

            // Check for Cue Identifier (optional)
            if (!line.includes('-->')) {
                i++; // Skip identifier line
                if (i >= lines.length) break;
                line = lines[i].trim();
            }

            // Parse Timing: 00:00:00.000 --> 00:00:05.000
            if (line.includes('-->')) {
                const parts = line.split('-->');
                const start = this.parseTime(parts[0].trim());
                const end = this.parseTime(parts[1].trim());

                // Collect text payload
                let payload = [];
                i++;
                while (i < lines.length && lines[i].trim() !== '') {
                    const lineStr = lines[i];
                    // Filter ASS drawing commands often found in raw VTT extractions
                    // Pattern: 'm <coords> ...'
                    if (/^m\s+-?\d+/.test(lineStr.trim())) {
                        console.warn(`[VTT-Debug] Ignored drawing line: "${lineStr.substring(0, 50)}..."`);
                    } else {
                        payload.push(lineStr);
                    }
                    i++;
                }

                if (payload.length === 0) {
                    console.warn(`[VTT-Debug] Skipped cue with no valid payload at ${start} --> ${end}`);
                    continue;
                }

                const textContent = payload.join('<br>');

                // Deduplicate consecutive identical cues
                let isDuplicate = false;
                if (this.cues.length > 0) {
                    const last = this.cues[this.cues.length - 1];
                    if (last.start === start && last.end === end && last.text === textContent) {
                        console.log(`[VTT-Debug] Deduplicated cue: ${start} --> ${end}`);
                        isDuplicate = true;
                    }
                }

                if (isDuplicate) continue;

                this.cues.push({
                    start,
                    end,
                    text: textContent,
                    html: textContent.replace(/<v [^>]+>/g, '').replace(/<\/v>/g, ''), // Basic strip of voice tags
                    format: 'vtt'
                });
                console.log(`[VTT-Debug] Accepted: ${start} --> ${end} : "${textContent.substring(0, 30)}..."`);
            } else {
                i++;
            }
        }
    }

    parseASS(text) {
        const lines = text.split(/\r?\n/);
        let section = '';
        const formatOrder = {}; // For Events
        const styleFormatOrder = {}; // For Styles

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            if (line.startsWith('[')) {
                section = line;
                continue;
            }

            if (section === '[Script Info]') {
                const parts = line.split(':');
                if (parts.length >= 2) {
                    const key = parts[0].trim();
                    const value = parts[1].trim();
                    if (key === 'PlayResX') this.assParams.playResX = parseInt(value);
                    if (key === 'PlayResY') this.assParams.playResY = parseInt(value);
                }
            }
            else if (section === '[V4+ Styles]' || section === '[V4 Styles]') {
                if (line.startsWith('Format:')) {
                    const parts = line.substring(7).split(',').map(s => s.trim());
                    parts.forEach((p, idx) => styleFormatOrder[p] = idx);
                } else if (line.startsWith('Style:')) {
                    const parts = line.substring(6).split(','); // Styles can contain commas in font names? rarely.
                    // Better split implementation handling quoted strings if needed, but standard ASS usually CSV
                    const style = {};

                    // Map parts to properties
                    for (const [key, idx] of Object.entries(styleFormatOrder)) {
                        if (idx < parts.length) style[key] = parts[idx].trim();
                    }

                    this.styles[style.Name] = style;
                }
            }
            else if (section === '[Events]') {
                if (line.startsWith('Format:')) {
                    const parts = line.substring(7).split(',').map(s => s.trim());
                    parts.forEach((p, idx) => formatOrder[p] = idx);
                } else if (line.startsWith('Dialogue:')) {
                    if (!formatOrder['Start'] || !formatOrder['End'] || !formatOrder['Text']) continue;

                    // Dialogue: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
                    // We must be careful because "Text" is the last field and can contain commas.

                    // Heuristic: Find the Nth comma where N is the index of 'Text'
                    // Actually, formatOrder['Text'] is the last index.
                    // So we split by comma limited to the number of fields - 1

                    const numFields = Object.keys(formatOrder).length;
                    // ASS lines: Key: v1, v2, v3, ..., "Text, with, commas"

                    // Find first colon
                    const firstColon = line.indexOf(':');
                    const content = line.substring(firstColon + 1).trim();

                    // Custom csv split that respects the last field being free-form
                    const values = [];
                    let currentVal = '';
                    let commaCount = 0;
                    let targetCommaCount = numFields - 1;

                    // Optimization: Standard JS split doesn't support "split N times".
                    // We can find the Nth comma position.
                    let lastCommaIndex = -1;
                    let foundCommas = 0;

                    for (let i = 0; i < content.length; i++) {
                        if (content[i] === ',') {
                            foundCommas++;
                            if (foundCommas === targetCommaCount) {
                                lastCommaIndex = i;
                                break;
                            }
                        }
                    }

                    const metaPart = content.substring(0, lastCommaIndex);
                    const textPart = content.substring(lastCommaIndex + 1);
                    const metaValues = metaPart.split(',').map(s => s.trim());

                    // Construct event object
                    const event = {};
                    // Map meta values
                    const formatKeys = Object.keys(formatOrder).sort((a, b) => formatOrder[a] - formatOrder[b]);

                    for (let i = 0; i < targetCommaCount; i++) {
                        if (i < metaValues.length) {
                            event[formatKeys[i]] = metaValues[i];
                        }
                    }
                    event['Text'] = textPart;

                    const start = this.parseASSTime(event['Start']);
                    const end = this.parseASSTime(event['End']);

                    if (isNaN(start) || isNaN(end)) continue;

                    // Clean up text
                    let rawText = event['Text'];

                    // Handle override tags
                    // Complex rendering requires drawing to Canvas or generating complex DOM.
                    // We will use DOM for now.

                    const overrides = this.parseOverrides(rawText);

                    // Basic Karaoke Processing
                    // Replace {\kXY}Text with <span class="karaoke-text" data-duration="XY">Text</span>
                    // This is a naive implementation.
                    let processedText = rawText;
                    let isKaraoke = false;

                    // Regex to find \k tags and the text following them until next tag or end
                    if (/\\k[fo]?\d+/.test(rawText)) {
                        isKaraoke = true;
                        // We need to strip other tags for the clean text, BUT keep K tags for processing.
                        // Simplification: Standardize to internal format
                        // Not implemented fully in this pass to avoid breaking standard rendering
                        // Instead, we just strip K tags for 'text' and keep them in 'html' if we were to support it.
                    }

                    const cleanText = rawText.replace(/{[^}]+}/g, '').replace(/\\N/g, '<br>').replace(/\\n/g, ' ');

                    this.cues.push({
                        start,
                        end,
                        text: cleanText,
                        rawText: rawText,
                        styleName: event['Style'],
                        overrides: overrides,
                        format: 'ass'
                    });
                }
            }
        }
    }

    parseOverrides(text) {
        const overrides = {};

        // Check for \pos(x,y)
        const posMatch = text.match(/\\pos\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/);
        if (posMatch) {
            overrides.pos = { x: parseFloat(posMatch[1]), y: parseFloat(posMatch[2]) };
        }

        // Check for \an(1-9) - Alignment (numpad)
        const anMatch = text.match(/\\an(\d)/);
        if (anMatch) {
            overrides.alignment = parseInt(anMatch[1]);
        }

        const cMatch = text.match(/\\c&H([0-9a-fA-F]+)&/);
        if (cMatch) {
            overrides.color = this.assColorToCss(cMatch[1]);
        }

        // Check for \fad(t1, t2) - Fade
        const fadMatch = text.match(/\\fad\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
        if (fadMatch) {
            overrides.fade = { t1: parseInt(fadMatch[1]), t2: parseInt(fadMatch[2]) };
        }

        // Check for \move(x1, y1, x2, y2, [t1, t2])
        // Regex handles optional t1, t2
        const moveMatch = text.match(/\\move\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)(?:\s*,\s*(\d+)\s*,\s*(\d+))?\s*\)/);
        if (moveMatch) {
            overrides.move = {
                x1: parseFloat(moveMatch[1]),
                y1: parseFloat(moveMatch[2]),
                x2: parseFloat(moveMatch[3]),
                y2: parseFloat(moveMatch[4]),
                t1: moveMatch[5] !== undefined ? parseInt(moveMatch[5]) : undefined,
                t2: moveMatch[6] !== undefined ? parseInt(moveMatch[6]) : undefined
            };
        }

        // Check for Rotation \frx, \fry, \frz (or \fr)
        const frxMatch = text.match(/\\frx(-?[\d.]+)/);
        const fryMatch = text.match(/\\fry(-?[\d.]+)/);
        const frzMatch = text.match(/\\frz(-?[\d.]+)/);
        const frMatch = text.match(/\\fr(-?[\d.]+)/); // Defaults to Z

        if (frxMatch || fryMatch || frzMatch || frMatch) {
            overrides.rotation = {
                x: frxMatch ? parseFloat(frxMatch[1]) : 0,
                y: fryMatch ? parseFloat(fryMatch[1]) : 0,
                z: frzMatch ? parseFloat(frzMatch[1]) : (frMatch ? parseFloat(frMatch[1]) : 0)
            };
        }

        // Check for Styling Overrides: \bord, \shad, \blur, \fs, \fn
        const bordMatch = text.match(/\\bord(-?[\d.]+)/);
        if (bordMatch) overrides.border = parseFloat(bordMatch[1]);

        const shadMatch = text.match(/\\shad(-?[\d.]+)/);
        if (shadMatch) overrides.shadow = parseFloat(shadMatch[1]);

        const blurMatch = text.match(/\\blur(-?[\d.]+)/);
        if (blurMatch) overrides.blur = parseFloat(blurMatch[1]);

        const fsMatch = text.match(/\\fs(\d+)/);
        if (fsMatch) overrides.fontSize = parseInt(fsMatch[1]);

        const fnMatch = text.match(/\\fn([^\\}]+)/);
        if (fnMatch) overrides.fontName = fnMatch[1];

        // Karaoke split logic (simplified)
        // \k10\k20 -> we won't fully highlight, just identifying presence
        // Real karaoke requires splitting the text node into spans.
        // We will attempt a basic parse: replace {\kXX}text with <span data-k="XX">text</span>
        // This is complex because overrides return an object, but karaoke changes the text structure.
        // We'll handle K-tag stripping in the main loop but flag it here if needed.

        return overrides;
    }

    parseTime(timeStr) {
        // 00:00:05.123 or 00:05.123
        const parts = timeStr.trim().split(':');
        let seconds = 0;
        if (parts.length === 3) {
            seconds += parseInt(parts[0]) * 3600;
            seconds += parseInt(parts[1]) * 60;
            seconds += parseFloat(parts[2]);
        } else if (parts.length === 2) {
            seconds += parseInt(parts[0]) * 60;
            seconds += parseFloat(parts[1]);
        }
        return seconds;
    }

    parseASSTime(timeStr) {
        // 0:00:05.12
        return this.parseTime(timeStr);
    }

    assColorToCss(assColor) {
        // ASS color is &HBBGGRR (optionally &HAABBGGRR)
        // We stripped &H and & already in regex usually, or raw value
        let hex = assColor.replace(/&H|&/g, '');

        // Pad to 6 or 8 chars
        while (hex.length < 6) hex = '0' + hex;

        // Alpha?
        let a = 1;
        if (hex.length === 8) {
            // First 2 bytes are alpha
            const alphaHex = hex.substring(0, 2);
            const alphaVal = parseInt(alphaHex, 16);
            // ASS Alpha: 00 = Opaque, FF = Transparent
            a = 1 - (alphaVal / 255);
            hex = hex.substring(2);
        }

        const b = hex.substring(0, 2);
        const g = hex.substring(2, 4);
        const r = hex.substring(4, 6);

        return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${a.toFixed(2)})`;
    }

    update() {
        if (!this.isEnabled) return;

        const time = this.video.currentTime;
        const active = this.cues.filter(cue => time >= cue.start && time <= cue.end);

        // Simple diff check (avoid redraw if same cues)
        // Use rawText for comparison to capture override changes if they were dynamic (rare)
        const activeKeys = active.map(c => c.rawText + c.start).join('|');
        const currentKeys = this.activeCues.map(c => c.rawText + c.start).join('|');

        if (activeKeys !== currentKeys) {
            const firstText = active.length > 0 ? active[0].text.substring(0, 30).replace(/<[^>]*>/g, '') + '...' : 'None';
            console.log(`[SubtitleRenderer] Active cues changed: ${active.length} active. First: "${firstText}"`);
            this.activeCues = active;
            this.render();
        }

        // Apply animations (Fade, etc) every frame
        this.applyAnimations(time);
    }

    applyAnimations(time) {
        if (this.activeCues.length === 0) return;
        const children = this.overlay.children;

        for (let i = 0; i < this.activeCues.length; i++) {
            const cue = this.activeCues[i];
            const div = children[i];
            if (!div) continue;

            // Handle Fade (\fad)
            if (cue.overrides && cue.overrides.fade) {
                const { t1, t2 } = cue.overrides.fade;
                let opacity = 1;
                const elapsed = (time - cue.start) * 1000; // ms
                const remaining = (cue.end - time) * 1000;

                if (elapsed < t1) opacity = elapsed / t1;
                else if (remaining < t2) opacity = remaining / t2;

                div.style.opacity = Math.max(0, Math.min(1, opacity));
            }

            // Handle Move (\move)
            if (cue.overrides && cue.overrides.move && this.activeScaleX && this.activeScaleY) {
                const { x1, y1, x2, y2, t1, t2 } = cue.overrides.move;
                const duration = (cue.end - cue.start) * 1000;
                // If t1/t2 not specified, move over full duration
                const startTime = (t1 !== undefined) ? t1 : 0;
                const endTime = (t2 !== undefined) ? t2 : duration;

                const elapsed = (time - cue.start) * 1000;
                let progress = 0;

                if (endTime > startTime) {
                    if (elapsed <= startTime) progress = 0;
                    else if (elapsed >= endTime) progress = 1;
                    else progress = (elapsed - startTime) / (endTime - startTime);
                } else {
                    progress = 1; // Instant move?
                }

                const currentX = x1 + (x2 - x1) * progress;
                const currentY = y1 + (y2 - y1) * progress;

                div.style.left = (currentX * this.activeScaleX) + 'px';
                div.style.top = (currentY * this.activeScaleY) + 'px';
            }
        }
    }

    render() {
        this.overlay.innerHTML = '';
        if (this.activeCues.length === 0) return;

        // Overlay is now sized to the video content, so we use its dims
        const containerWidth = this.overlay.clientWidth;
        const containerHeight = this.overlay.clientHeight;

        // Calculate scaling factor
        // ASS coordinates are based on PlayResX/Y
        // We scale everything to fit the current video container
        let scaleX = 1;
        let scaleY = 1;

        if (this.format === 'ass' && this.assParams.playResX) {
            scaleX = containerWidth / this.assParams.playResX;
            // Should we preserve aspect ratio or stretch? ASS usually assumes stretch if not specified otherwise
            scaleY = containerHeight / this.assParams.playResY;

            // Most renderers use one scale factor for fonts to avoid distortion, usually based on Height or Width
            // We'll use Y for font sizes
        }

        this.activeScaleX = scaleX;
        this.activeScaleY = scaleY;

        this.activeCues.forEach(cue => {
            const div = document.createElement('div');

            if (cue.format === 'vtt') {
                div.className = 'subtitle-line vtt-style';
                div.innerHTML = cue.text;
            } else {
                // ASS Rendering
                div.className = 'subtitle-line ass-style';
                div.innerHTML = cue.text;

                // Apply Styles
                const style = this.styles[cue.styleName] || this.styles['Default'] || {};

                // Font params
                let fontSize = parseInt(style.Fontsize) || 20;
                const color = style.PrimaryColour ? this.assColorToCss(style.PrimaryColour) : 'white';
                const outlineColor = style.OutlineColour ? this.assColorToCss(style.OutlineColour) : 'black';
                const shadowColor = style.BackColour ? this.assColorToCss(style.BackColour) : 'rgba(0,0,0,0.5)';
                const bold = style.Bold === '-1' || style.Bold === '1';
                const italic = style.Italic === '-1' || style.Italic === '1';
                const outlineWidth = (parseFloat(style.Outline) || 2) * scaleX;

                // Positioning
                // Default alignment
                let alignment = parseInt(style.Alignment) || 2; // Default bottom-center

                if (cue.overrides) {
                    if (cue.overrides.alignment) alignment = cue.overrides.alignment;

                    // Font Overrides
                    if (cue.overrides.fontSize) div.style.fontSize = (cue.overrides.fontSize * scaleY) + 'px';
                    if (cue.overrides.fontName) div.style.fontFamily = cue.overrides.fontName;

                    // 3D Rotation
                    if (cue.overrides.rotation) {
                        const { x, y, z } = cue.overrides.rotation;
                        // To work, parent needs perspective. We add it to the div itself or we rely on flattened 3d?
                        // Adding perspective to the element usually works for self-rotation
                        div.style.transformStyle = 'preserve-3d';
                        // We will append rotation to the transform string later or here
                        // Note: Transform is overwritten by positioning functions. We must merge them.
                        div.dataset.rotation = `rotateX(${x}deg) rotateY(${y}deg) rotateZ(${z}deg)`;
                    }

                    // Border/Shadow/Blur Overrides
                    let currentOutline = outlineWidth;
                    let currentShadow = style.BackColour ? 1 : 0; // heuristic
                    let currentBlur = 0;

                    if (cue.overrides.border !== undefined) currentOutline = cue.overrides.border * scaleX;
                    if (cue.overrides.shadow !== undefined) currentShadow = cue.overrides.shadow * scaleX;
                    if (cue.overrides.blur !== undefined) currentBlur = cue.overrides.blur;

                    if (currentBlur > 0) {
                        div.style.filter = `blur(${currentBlur}px)`;
                    }

                    // Re-apply shadow/outline with overrides
                    if (currentOutline > 0 || currentShadow > 0) {
                        const c = outlineColor;
                        const s = shadowColor;
                        const o = currentOutline;
                        // Combined text-shadow for outline
                        let shadowStr = '';
                        if (o > 0) {
                            shadowStr += `-${o}px -${o}px 0 ${c}, ${o}px -${o}px 0 ${c}, -${o}px ${o}px 0 ${c}, ${o}px ${o}px 0 ${c}`;
                        }
                        if (currentShadow > 0) {
                            if (shadowStr) shadowStr += ', ';
                            shadowStr += `${currentShadow}px ${currentShadow}px ${currentBlur}px ${s}`;
                        }
                        div.style.textShadow = shadowStr;
                    }

                    // Priority: Move > Pos > Standard
                    if (cue.overrides.move) {
                        // Initial pos is x1, y1
                        div.style.position = 'absolute';
                        div.style.left = (cue.overrides.move.x1 * scaleX) + 'px';
                        div.style.top = (cue.overrides.move.y1 * scaleY) + 'px';
                        this.applyAlignmentTransform(div, alignment);

                        if (cue.overrides.color) div.style.color = cue.overrides.color;
                        else div.style.color = color;
                    }
                    else if (cue.overrides.pos) {
                        // Absolute positioning (Explicit)
                        div.style.position = 'absolute';
                        div.style.left = (cue.overrides.pos.x * scaleX) + 'px';
                        div.style.top = (cue.overrides.pos.y * scaleY) + 'px';
                        this.applyAlignmentTransform(div, alignment);

                        // Apply color override if present
                        if (cue.overrides.color) div.style.color = cue.overrides.color;
                        else div.style.color = color;
                    } else {
                        // Flex/Standard Alignment with Overrides
                        this.applyFlexAlignment(div, alignment, style, scaleX, scaleY);
                        if (cue.overrides.color) div.style.color = cue.overrides.color;
                        else div.style.color = color;
                    }
                } else {
                    // No overrides - Standard Alignment
                    div.style.color = color;
                    this.applyFlexAlignment(div, alignment, style, scaleX, scaleY);
                }

                // Font Styling
                div.style.fontSize = (fontSize * scaleY) + 'px'; // Scale font by Y
                div.style.fontFamily = style.Fontname || 'Arial, sans-serif';
                if (bold) div.style.fontWeight = 'bold';
                if (italic) div.style.fontStyle = 'italic';

                // Outline/Shadow
                // Already defined above: outlineWidth

                // CSS text-stroke is non-standard but widely supported. Text-shadow is safer.
                // Simulating outline with text-shadow
                if (outlineWidth > 0) {
                    const o = outlineWidth;
                    const c = outlineColor;
                    div.style.textShadow = `-${o}px -${o}px 0 ${c}, ${o}px -${o}px 0 ${c}, -${o}px ${o}px 0 ${c}, ${o}px ${o}px 0 ${c}`;
                }
            }

            this.overlay.appendChild(div);
        });
    }

    applyAlignmentTransform(element, alignment) {
        // Used for \pos overrides (Absolute positioning)
        // alignment matches numpad (1-9)
        let tx = '-50%';
        let ty = '-50%';

        switch (alignment) {
            case 1: tx = '0%'; ty = '-100%'; break; // Bottom Left
            case 2: tx = '-50%'; ty = '-100%'; break; // Bottom Center
            case 3: tx = '-100%'; ty = '-100%'; break; // Bottom Right
            case 4: tx = '0%'; ty = '-50%'; break; // Middle Left
            case 5: tx = '-50%'; ty = '-50%'; break; // Middle Center
            case 6: tx = '-100%'; ty = '-50%'; break; // Middle Right
            case 7: tx = '0%'; ty = '0%'; break; // Top Left
            case 8: tx = '-50%'; ty = '0%'; break; // Top Center
            case 9: tx = '-100%'; ty = '0%'; break; // Top Right
        }

        let transform = `translate(${tx}, ${ty})`;
        if (element.dataset.rotation) {
            transform += ' ' + element.dataset.rotation;
            // Add perspective to parent to make 3D effect visible?
            // Or just adds perspective to element.
            // 800px is a reasonable default perspective
            element.style.perspective = '800px';
        }
        element.style.transform = transform;
    }

    applyFlexAlignment(element, alignment, style, scaleX, scaleY) {
        // Alignment 1-9
        element.style.position = 'absolute';
        element.style.whiteSpace = 'nowrap';

        // Calculate Margins/Padding
        // We use them as padding for full-width containers (centered) 
        // or margins for variable-width (left/right aligned)
        const mL = (parseInt(style.MarginL) || 10) * scaleX;
        const mR = (parseInt(style.MarginR) || 10) * scaleX;
        const mV = (parseInt(style.MarginV) || 10) * scaleY;

        // Vertical Alignment
        if ([7, 8, 9].includes(alignment)) { // Top
            element.style.top = `${mV}px`;
            element.style.bottom = 'auto';
        } else if ([4, 5, 6].includes(alignment)) { // Middle
            element.style.top = '50%';
            element.style.bottom = 'auto';
            element.style.transform = 'translateY(-50%)';
        } else { // Bottom (1, 2, 3)
            element.style.top = 'auto';
            element.style.bottom = `${mV}px`;
        }

        // Horizontal Alignment
        if ([1, 4, 7].includes(alignment)) { // Left
            element.style.left = `${mL}px`;
            element.style.right = 'auto';
            element.style.textAlign = 'left';
            element.style.width = 'auto';
        } else if ([3, 6, 9].includes(alignment)) { // Right
            element.style.left = 'auto';
            element.style.right = `${mR}px`;
            element.style.textAlign = 'right';
            element.style.width = 'auto';
        } else { // Center (2, 5, 8)
            // Use full width with padding to ensure correct centering between margins
            element.style.left = '0';
            element.style.width = '100%';
            element.style.textAlign = 'center';
            // Use padding to restrict the "center" area
            // box-sizing: border-box is important here, usually inherited or default content-box
            // We'll enforce border-box for calculation safety
            element.style.boxSizing = 'border-box';
            element.style.paddingLeft = `${mL}px`;
            element.style.paddingRight = `${mR}px`;

            // Remove transform X since we are using width 100%
            if (element.style.transform && element.style.transform.includes('translateY')) {
                if (element.dataset.rotation) {
                    element.style.transform += ' ' + element.dataset.rotation;
                }
            } else if (element.style.transform) {
                let t = element.style.transform.replace(/translateX\([^)]+\)/, '');
                if (element.dataset.rotation) t += ' ' + element.dataset.rotation;
                element.style.transform = t;
            } else if (element.dataset.rotation) {
                element.style.transform = element.dataset.rotation;
            }
        }
    }

    resize() {
        if (!this.video || !this.overlay) return;

        // Calculate real video dimensions (content rect)
        const vidW = this.video.videoWidth;
        const vidH = this.video.videoHeight;
        if (!vidW || !vidH) return; // Video not loaded yet

        const containerW = this.video.clientWidth || window.innerWidth;
        const containerH = this.video.clientHeight || window.innerHeight;

        const vidRatio = vidW / vidH;
        const containerRatio = containerW / containerH;

        let realW, realH, osX, osY;

        if (containerRatio > vidRatio) {
            // Container is wider (Pillarbox)
            realH = containerH;
            realW = realH * vidRatio;
            osX = (containerW - realW) / 2;
            osY = 0;
        } else {
            // Container is taller (Letterbox)
            realW = containerW;
            realH = realW / vidRatio;
            osX = 0;
            osY = (containerH - realH) / 2;
        }

        // Apply to overlay
        this.overlay.style.width = `${realW}px`;
        this.overlay.style.height = `${realH}px`;
        this.overlay.style.left = `${osX}px`;
        this.overlay.style.top = `${osY}px`;

        // Re-render to update scaling with new Overlay dimensions
        if (this.activeCues.length > 0) {
            this.render();
        }
    }
}

// Export specific for browser context?
// Just attach to window to be safe/simple
window.SubtitleRenderer = SubtitleRenderer;
