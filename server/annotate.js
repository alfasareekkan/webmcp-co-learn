// Screenshot annotation engine using sharp + SVG overlays.
// Draws highlight boxes, arrows, numbered labels, and pulsing circles
// on top of the captured screenshot.

import sharp from "sharp";

/**
 * Annotate a screenshot with highlighted regions.
 *
 * @param {string} screenshotBase64 - base64 JPEG/PNG data (without data: prefix)
 * @param {Array<{x:number, y:number, width:number, height:number, label?:string, color?:string}>} highlights
 * @param {{width:number, height:number, dpr?:number}} viewport
 * @returns {Promise<string>} - data URL of annotated JPEG
 */
export async function annotateScreenshot(screenshotBase64, highlights, viewport) {
  if (!highlights?.length || !screenshotBase64) return null;

  const imgBuffer = Buffer.from(screenshotBase64, "base64");
  const meta = await sharp(imgBuffer).metadata();
  const imgW = meta.width;
  const imgH = meta.height;

  // Calculate scale factor (screenshot may be at device pixel ratio)
  const dpr = viewport?.dpr || (imgW / (viewport?.width || imgW));
  const scale = dpr;

  const svgParts = [];

  highlights.forEach((h, i) => {
    const x = Math.round(h.x * scale);
    const y = Math.round(h.y * scale);
    const w = Math.round(h.width * scale);
    const hh = Math.round(h.height * scale);
    const color = h.color || "#FF3B6F";
    const label = h.label || `${i + 1}`;

    // Highlight box with rounded corners
    svgParts.push(`
      <rect x="${x}" y="${y}" width="${w}" height="${hh}"
        rx="6" ry="6"
        fill="${color}22" stroke="${color}" stroke-width="3"
        stroke-dasharray="${w > 200 ? "none" : "none"}" />
    `);

    // Pulsing corner dots
    const dotR = Math.max(5, Math.min(10, w * 0.04));
    svgParts.push(`
      <circle cx="${x}" cy="${y}" r="${dotR}" fill="${color}" />
      <circle cx="${x + w}" cy="${y}" r="${dotR}" fill="${color}" />
      <circle cx="${x}" cy="${y + hh}" r="${dotR}" fill="${color}" />
      <circle cx="${x + w}" cy="${y + hh}" r="${dotR}" fill="${color}" />
    `);

    // Number label badge
    const badgeW = Math.max(28, label.length * 10 + 16);
    const badgeH = 24;
    const badgeX = Math.max(0, x - 2);
    const badgeY = Math.max(0, y - badgeH - 4);

    svgParts.push(`
      <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}"
        rx="12" ry="12" fill="${color}" />
      <text x="${badgeX + badgeW / 2}" y="${badgeY + badgeH / 2 + 1}"
        font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="bold"
        fill="white" text-anchor="middle" dominant-baseline="central">
        ${escapeXml(label)}
      </text>
    `);

    // Arrow pointing to center of element (from top-left of badge)
    if (h.arrow !== false) {
      const arrowStartX = badgeX + badgeW / 2;
      const arrowStartY = badgeY + badgeH;
      const arrowEndX = x + w / 2;
      const arrowEndY = y + 2;

      if (Math.abs(arrowEndY - arrowStartY) > 10) {
        svgParts.push(`
          <line x1="${arrowStartX}" y1="${arrowStartY}" x2="${arrowEndX}" y2="${arrowEndY}"
            stroke="${color}" stroke-width="2" marker-end="url(#arrowhead-${i})" />
          <defs>
            <marker id="arrowhead-${i}" markerWidth="8" markerHeight="6"
              refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
              <polygon points="0 0, 8 3, 0 6" fill="${color}" />
            </marker>
          </defs>
        `);
      }
    }
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}">
    ${svgParts.join("\n")}
  </svg>`;

  const svgBuffer = Buffer.from(svg);

  const annotated = await sharp(imgBuffer)
    .composite([{ input: svgBuffer, top: 0, left: 0 }])
    .jpeg({ quality: 80 })
    .toBuffer();

  return `data:image/jpeg;base64,${annotated.toString("base64")}`;
}

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
