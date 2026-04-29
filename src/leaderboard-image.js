// leaderboard-image.js
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

// Register system fonts - try multiple locations for cross-platform support
function registerFonts() {
  const fontPaths = [
    // Linux (Railway)
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    // macOS
    '/System/Library/Fonts/Helvetica.ttc',
    // Windows
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\arialbd.ttf',
  ];

  let registered = false;
  for (const fp of fontPaths) {
    if (fs.existsSync(fp)) {
      try {
        GlobalFonts.registerFromPath(fp);
        registered = true;
        console.log(`[Leaderboard] Registered font: ${fp}`);
        break;
      } catch (e) {}
    }
  }

  if (!registered) {
    console.warn('[Leaderboard] No system font found — text may not render');
  }
}

registerFonts();

const COLORS = {
  bg: '#0f0f13', bg2: '#16161f', bg3: '#1e1e2a',
  border: '#2a2a3a', accent: '#7c6cf0', accent2: '#a78bfa',
  text: '#f4f4f8', text2: '#9898b0', text3: '#5a5a72',
  gold: '#fbbf24', silver: '#94a3b8', bronze: '#cd7c3a',
  ok: '#34d399', bar: '#2a2a3a',
};

function initials(name) {
  return (name || '?').split(/[\s._]+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function rankColor(i) {
  if (i === 0) return COLORS.gold;
  if (i === 1) return COLORS.silver;
  if (i === 2) return COLORS.bronze;
  return COLORS.text2;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function generateLeaderboard(reporters, suggestions, serverName = 'DevTrack') {
  const W = 800;
  const PAD = 28;
  const ROW = 68;
  const TOP_N = Math.min(reporters.length, 10);
  const HAS_SUGG = suggestions && suggestions.length > 0;
  const SUGG_N = Math.min(suggestions?.length || 0, 5);
  const H = 120 + TOP_N * ROW + (HAS_SUGG ? 60 + SUGG_N * (ROW - 8) : 0) + PAD * 2;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // Top gradient bar
  const topGrad = ctx.createLinearGradient(0, 0, W, 0);
  topGrad.addColorStop(0, '#7c6cf0');
  topGrad.addColorStop(1, '#a78bfa');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, 5);

  // Get available font family
  const fonts = GlobalFonts.families;
  const fontFamily = fonts.length > 0 ? fonts[0].family : 'sans-serif';
  console.log(`[Leaderboard] Using font: ${fontFamily}, families: ${JSON.stringify(fonts.map(f=>f.family))}`);

  // Header
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 30px "${fontFamily}"`;
  ctx.fillText('Bug Reporter Leaderboard', PAD + 8, 52);

  ctx.fillStyle = COLORS.text2;
  ctx.font = `15px "${fontFamily}"`;
  ctx.fillText(`${serverName}  ·  ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`, PAD + 8, 80);

  // Divider
  ctx.fillStyle = COLORS.border;
  ctx.fillRect(PAD, 95, W - PAD * 2, 1);

  // Bug reporters
  const maxCount = reporters[0]?.count || 1;
  reporters.slice(0, TOP_N).forEach((r, i) => {
    const ry = 110 + i * ROW;
    const isTop = i < 3;

    // Row bg
    roundRect(ctx, PAD, ry, W - PAD * 2, ROW - 6, 10);
    ctx.fillStyle = isTop ? 'rgba(124,108,240,0.08)' : COLORS.bg2;
    ctx.fill();
    if (isTop) {
      ctx.strokeStyle = 'rgba(124,108,240,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Rank
    ctx.font = `bold 18px "${fontFamily}"`;
    ctx.fillStyle = rankColor(i);
    ctx.textAlign = 'center';
    const rankText = i < 3 ? ['1st','2nd','3rd'][i] : `#${i+1}`;
    ctx.fillText(rankText, PAD + 28, ry + 36);
    ctx.textAlign = 'left';

    // Avatar circle
    const ax = PAD + 68, ay = ry + 28;
    ctx.beginPath();
    ctx.arc(ax, ay, 22, 0, Math.PI * 2);
    const ag = ctx.createRadialGradient(ax, ay, 0, ax, ay, 22);
    ag.addColorStop(0, isTop ? '#9d8df5' : '#3a3a52');
    ag.addColorStop(1, isTop ? '#6c5ce7' : '#2a2a3a');
    ctx.fillStyle = ag;
    ctx.fill();

    ctx.font = `bold 12px "${fontFamily}"`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(initials(r.name), ax, ay + 5);
    ctx.textAlign = 'left';

    // Name
    ctx.font = `bold 16px "${fontFamily}"`;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(r.name, PAD + 100, ry + 24);

    // Breakdown
    const parts = [];
    if (r.major) parts.push(`${r.major} major`);
    if (r.moderate) parts.push(`${r.moderate} moderate`);
    if (r.minor) parts.push(`${r.minor} minor`);
    ctx.font = `12px "${fontFamily}"`;
    ctx.fillStyle = COLORS.text3;
    ctx.fillText(parts.join('  ') || 'no breakdown', PAD + 100, ry + 44);

    // Bar
    const bx = PAD + 100, by = ry + 51, bw = W - PAD * 2 - 100 - 70, bh = 3;
    roundRect(ctx, bx, by, bw, bh, 2);
    ctx.fillStyle = COLORS.bar; ctx.fill();
    const fill = Math.round((r.count / maxCount) * bw);
    if (fill > 0) {
      roundRect(ctx, bx, by, fill, bh, 2);
      const bg = ctx.createLinearGradient(bx, 0, bx + fill, 0);
      bg.addColorStop(0, '#7c6cf0');
      bg.addColorStop(1, '#a78bfa');
      ctx.fillStyle = bg; ctx.fill();
    }

    // Count
    ctx.font = `bold 26px "${fontFamily}"`;
    ctx.fillStyle = isTop ? COLORS.accent2 : COLORS.text2;
    ctx.textAlign = 'right';
    ctx.fillText(String(r.count), W - PAD, ry + 40);
    ctx.textAlign = 'left';
  });

  // Suggestion section
  if (HAS_SUGG && SUGG_N > 0) {
    const sy = 110 + TOP_N * ROW + 16;
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(PAD, sy, W - PAD * 2, 1);

    ctx.font = `bold 16px "${fontFamily}"`;
    ctx.fillStyle = COLORS.text2;
    ctx.fillText('Top Suggestion Contributors', PAD, sy + 28);

    const maxS = suggestions[0]?.count || 1;
    suggestions.slice(0, SUGG_N).forEach((s, i) => {
      const ry = sy + 40 + i * (ROW - 10);
      roundRect(ctx, PAD, ry, W - PAD * 2, ROW - 14, 8);
      ctx.fillStyle = COLORS.bg2; ctx.fill();

      ctx.font = `bold 13px "${fontFamily}"`;
      ctx.fillStyle = rankColor(i);
      ctx.textAlign = 'center';
      ctx.fillText(i < 3 ? ['1st','2nd','3rd'][i] : `#${i+1}`, PAD + 22, ry + 30);
      ctx.textAlign = 'left';

      const ax = PAD + 52, ay = ry + 25;
      ctx.beginPath(); ctx.arc(ax, ay, 16, 0, Math.PI * 2);
      ctx.fillStyle = '#2a2a3a'; ctx.fill();
      ctx.font = `bold 9px "${fontFamily}"`;
      ctx.fillStyle = COLORS.accent2;
      ctx.textAlign = 'center';
      ctx.fillText(initials(s.name), ax, ay + 3);
      ctx.textAlign = 'left';

      ctx.font = `bold 14px "${fontFamily}"`;
      ctx.fillStyle = COLORS.text;
      ctx.fillText(s.name, PAD + 76, ry + 29);

      const bx = PAD + 76, by = ry + 38, bw = W - PAD*2 - 76 - 65, bh = 3;
      roundRect(ctx, bx, by, bw, bh, 2); ctx.fillStyle = COLORS.bar; ctx.fill();
      const fill = Math.round((s.count / maxS) * bw);
      if (fill > 0) { roundRect(ctx, bx, by, fill, bh, 2); ctx.fillStyle = '#a78bfa'; ctx.fill(); }

      ctx.font = `bold 18px "${fontFamily}"`;
      ctx.fillStyle = COLORS.accent2;
      ctx.textAlign = 'right';
      ctx.fillText(String(s.count), W - PAD, ry + 30);
      ctx.textAlign = 'left';
    });
  }

  // Footer
  ctx.font = `11px "${fontFamily}"`;
  ctx.fillStyle = COLORS.text3;
  ctx.textAlign = 'center';
  ctx.fillText('DevTrack Engineering Dashboard', W / 2, H - 8);

  return canvas.toBuffer('image/png');
}

module.exports = { generateLeaderboard };