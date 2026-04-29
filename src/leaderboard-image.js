// leaderboard-image.js
// Generates a styled leaderboard image using canvas

const { createCanvas } = require('canvas');

const COLORS = {
  bg:       '#0f0f13',
  bg2:      '#16161f',
  bg3:      '#1e1e2a',
  border:   '#2a2a3a',
  accent:   '#7c6cf0',
  accent2:  '#a78bfa',
  text:     '#f4f4f8',
  text2:    '#9898b0',
  text3:    '#5a5a72',
  gold:     '#fbbf24',
  silver:   '#94a3b8',
  bronze:   '#b45309',
  ok:       '#34d399',
  err:      '#f87171',
  warn:     '#fbbf24',
  bar:      '#2a2a3a',
};

const MEDALS = ['🥇', '🥈', '🥉'];

function initials(name) {
  return (name || '?').split(/[\s._]+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function rankColor(i) {
  if (i === 0) return COLORS.gold;
  if (i === 1) return COLORS.silver;
  if (i === 2) return COLORS.bronze;
  return COLORS.text2;
}

function drawRoundRect(ctx, x, y, w, h, r) {
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
  const WIDTH = 800;
  const PADDING = 28;
  const ROW_H = 70;
  const HEADER_H = 110;
  const TOP_N = Math.min(reporters.length, 10);
  const HAS_SUGG = suggestions && suggestions.length > 0;
  const SUGG_TOP = Math.min(suggestions?.length || 0, 5);

  // Calculate height
  const bugsSection = HEADER_H + TOP_N * ROW_H + 40;
  const suggSection = HAS_SUGG ? (60 + SUGG_TOP * ROW_H + 20) : 0;
  const HEIGHT = bugsSection + suggSection + PADDING * 2 + 20;

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Subtle grid pattern
  ctx.strokeStyle = 'rgba(124,108,240,0.03)';
  ctx.lineWidth = 1;
  for (let x = 0; x < WIDTH; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, HEIGHT); ctx.stroke();
  }
  for (let y = 0; y < HEIGHT; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WIDTH, y); ctx.stroke();
  }

  // Top accent bar
  const grad = ctx.createLinearGradient(0, 0, WIDTH, 0);
  grad.addColorStop(0, '#7c6cf0');
  grad.addColorStop(1, '#a78bfa');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, 4);

  // Header
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText('🏆  Bug Reporter Leaderboard', PADDING, 58);

  ctx.fillStyle = COLORS.text2;
  ctx.font = '15px sans-serif';
  ctx.fillText(serverName + ' · ' + new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), PADDING, 85);

  // Divider
  ctx.fillStyle = COLORS.border;
  ctx.fillRect(PADDING, 98, WIDTH - PADDING * 2, 1);

  // ── Bug Reporters ──
  let y = HEADER_H + PADDING;
  const maxCount = reporters[0]?.count || 1;

  reporters.slice(0, TOP_N).forEach((r, i) => {
    const rowY = y + i * ROW_H;
    const isTop3 = i < 3;

    // Row bg
    drawRoundRect(ctx, PADDING, rowY, WIDTH - PADDING * 2, ROW_H - 8, 10);
    ctx.fillStyle = isTop3 ? `rgba(124,108,240,0.07)` : COLORS.bg2;
    ctx.fill();
    if (isTop3) {
      ctx.strokeStyle = `rgba(124,108,240,0.2)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Rank
    ctx.font = 'bold 20px sans-serif';
    ctx.fillStyle = rankColor(i);
    ctx.textAlign = 'center';
    ctx.fillText(i < 3 ? ['🥇','🥈','🥉'][i] : `#${i+1}`, PADDING + 30, rowY + 38);
    ctx.textAlign = 'left';

    // Avatar circle
    const ax = PADDING + 65;
    const ay = rowY + 30;
    const AR = 20;
    ctx.beginPath();
    ctx.arc(ax, ay, AR, 0, Math.PI * 2);
    const aGrad = ctx.createRadialGradient(ax, ay, 0, ax, ay, AR);
    aGrad.addColorStop(0, isTop3 ? '#9d8df5' : '#3a3a52');
    aGrad.addColorStop(1, isTop3 ? '#6c5ce7' : '#2a2a3a');
    ctx.fillStyle = aGrad;
    ctx.fill();

    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(initials(r.name), ax, ay + 4);
    ctx.textAlign = 'left';

    // Name
    ctx.font = 'bold 16px sans-serif';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(r.name, PADDING + 96, rowY + 26);

    // Bug level breakdown
    const breakdown = [
      r.major ? `${r.major} major` : '',
      r.moderate ? `${r.moderate} moderate` : '',
      r.minor ? `${r.minor} minor` : '',
    ].filter(Boolean).join('  ');
    ctx.font = '12px sans-serif';
    ctx.fillStyle = COLORS.text3;
    ctx.fillText(breakdown, PADDING + 96, rowY + 46);

    // Progress bar
    const barX = PADDING + 96;
    const barY = rowY + 52;
    const barW = WIDTH - PADDING * 2 - 96 - 80;
    const barH = 3;
    drawRoundRect(ctx, barX, barY, barW, barH, 2);
    ctx.fillStyle = COLORS.bar;
    ctx.fill();
    const fill = Math.round((r.count / maxCount) * barW);
    if (fill > 0) {
      drawRoundRect(ctx, barX, barY, fill, barH, 2);
      const barGrad = ctx.createLinearGradient(barX, 0, barX + fill, 0);
      barGrad.addColorStop(0, '#7c6cf0');
      barGrad.addColorStop(1, '#a78bfa');
      ctx.fillStyle = barGrad;
      ctx.fill();
    }

    // Count
    ctx.font = 'bold 26px sans-serif';
    ctx.fillStyle = isTop3 ? COLORS.accent2 : COLORS.text2;
    ctx.textAlign = 'right';
    ctx.fillText(r.count, WIDTH - PADDING, rowY + 40);
    ctx.textAlign = 'left';
  });

  // ── Suggestion Contributors ──
  if (HAS_SUGG && SUGG_TOP > 0) {
    const suggY = y + TOP_N * ROW_H + 20;

    ctx.fillStyle = COLORS.border;
    ctx.fillRect(PADDING, suggY, WIDTH - PADDING * 2, 1);

    ctx.font = 'bold 18px sans-serif';
    ctx.fillStyle = COLORS.text2;
    ctx.fillText('💡  Top Suggestion Contributors', PADDING, suggY + 30);

    const maxSugg = suggestions[0]?.count || 1;
    suggestions.slice(0, SUGG_TOP).forEach((s, i) => {
      const rowY = suggY + 45 + i * ROW_H;

      drawRoundRect(ctx, PADDING, rowY, WIDTH - PADDING * 2, ROW_H - 10, 8);
      ctx.fillStyle = COLORS.bg2;
      ctx.fill();

      ctx.font = 'bold 14px sans-serif';
      ctx.fillStyle = rankColor(i);
      ctx.textAlign = 'center';
      ctx.fillText(i < 3 ? ['🥇','🥈','🥉'][i] : `#${i+1}`, PADDING + 22, rowY + 34);
      ctx.textAlign = 'left';

      // Avatar
      const ax = PADDING + 52, ay = rowY + 28;
      ctx.beginPath();
      ctx.arc(ax, ay, 16, 0, Math.PI * 2);
      ctx.fillStyle = '#2a2a3a';
      ctx.fill();
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = COLORS.accent2;
      ctx.textAlign = 'center';
      ctx.fillText(initials(s.name), ax, ay + 3);
      ctx.textAlign = 'left';

      ctx.font = 'bold 14px sans-serif';
      ctx.fillStyle = COLORS.text;
      ctx.fillText(s.name, PADDING + 76, rowY + 32);

      const barX = PADDING + 76, barY = rowY + 44, barW = WIDTH - PADDING*2 - 76 - 70, barH = 3;
      drawRoundRect(ctx, barX, barY, barW, barH, 2);
      ctx.fillStyle = COLORS.bar; ctx.fill();
      const fill = Math.round((s.count / maxSugg) * barW);
      if (fill > 0) {
        drawRoundRect(ctx, barX, barY, fill, barH, 2);
        ctx.fillStyle = '#a78bfa'; ctx.fill();
      }

      ctx.font = 'bold 20px sans-serif';
      ctx.fillStyle = COLORS.accent2;
      ctx.textAlign = 'right';
      ctx.fillText(s.count, WIDTH - PADDING, rowY + 34);
      ctx.textAlign = 'left';
    });
  }

  // Footer
  ctx.font = '11px sans-serif';
  ctx.fillStyle = COLORS.text3;
  ctx.textAlign = 'center';
  ctx.fillText('DevTrack Engineering Dashboard', WIDTH / 2, HEIGHT - 10);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}

module.exports = { generateLeaderboard };