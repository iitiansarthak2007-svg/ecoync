// public/minichart.js
// EcoSync's own tiny canvas chart renderer.
//
// WHY THIS EXISTS: the previous build pulled Chart.js from a public CDN
// (cdnjs.cloudflare.com). That is a hard dependency on internet access —
// exactly what a hackathon demo room cannot guarantee. If the CDN request
// failed, `Chart` was undefined, `new Chart(...)` threw, and both the
// "Last 24 hours" and "Forecast" charts silently stayed blank.
//
// This file implements just enough of the Chart.js constructor shape
// (`new Chart(canvas, { type, data, options })`, plus `.data.labels`,
// `.data.datasets[i].data`, and `.update()`) that app.js did not need to
// change at all. It draws with the plain Canvas 2D API — zero
// dependencies, zero network calls, works with no internet whatsoever.
// Supports exactly what EcoSync's dashboard needs: multi-line charts with
// an optional secondary (right) y-axis, and grouped bar charts.

(function (global) {
  function niceMax(v) {
    if (!isFinite(v) || v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    let step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }

  function axisRange(scaleCfg, values) {
    let min = scaleCfg && typeof scaleCfg.min === 'number' ? scaleCfg.min : 0;
    let max = scaleCfg && typeof scaleCfg.max === 'number' ? scaleCfg.max : null;
    if (max === null) {
      const dataMax = values.length ? Math.max(...values) : 1;
      max = niceMax(dataMax * 1.15);
      if (max <= min) max = min + 1;
    }
    return { min, max };
  }

  function pickTickIndices(count, maxTicks) {
    if (count <= maxTicks) return Array.from({ length: count }, (_, i) => i);
    const step = Math.ceil(count / maxTicks);
    const idx = [];
    for (let i = 0; i < count; i += step) idx.push(i);
    if (idx[idx.length - 1] !== count - 1) idx.push(count - 1);
    return idx;
  }

  class MiniChart {
    constructor(canvas, config) {
      this.canvas = canvas;
      this.type = config.type;
      this.data = config.data;
      this.chartOptions = config.options || {};
      // Resize handling is debounced with rAF so a drag-resize or an
      // orientation change coalesces into one redraw per frame instead of
      // one per event — no layout thrashing, no expensive continuous handler.
      this._raf = 0;
      this._onResize = () => {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
      };
      window.addEventListener('resize', this._onResize, { passive: true });
      window.addEventListener('orientationchange', this._onResize, { passive: true });

      // ResizeObserver catches the cases a window resize never fires for:
      // the sidebar drawer opening, a panel becoming visible, or the card
      // reflowing into a different grid column count.
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(this._onResize);
        this._ro.observe(canvas.parentElement || canvas);
      }
      this._draw();
    }

    update() {
      this._draw();
    }

    destroy() {
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('orientationchange', this._onResize);
      if (this._ro) this._ro.disconnect();
      if (this._raf) cancelAnimationFrame(this._raf);
    }

    _draw() {
      const canvas = this.canvas;
      const dpr = window.devicePixelRatio || 1;

      // SIZING: the canvas' rendered CSS box is the single source of truth.
      // styles.css gives .chart-card canvas a fluid `height: clamp(...)` and
      // `width:100%`, so the chart tracks its container at every breakpoint.
      // The previous inline height is cleared first, otherwise the value we
      // wrote on the last draw would pin the box and the chart could grow
      // but never shrink. A `height` attribute, if one is still present on a
      // canvas, is honoured as the fallback for backwards compatibility.
      canvas.style.height = '';
      const parent = canvas.parentElement;
      const cssWidth = Math.max(1, canvas.clientWidth || (parent && parent.clientWidth) || 320);
      const attrHeight = Number(canvas.getAttribute('height'));
      let cssHeight = canvas.clientHeight || (attrHeight > 0 ? attrHeight : 0) || 160;
      cssHeight = Math.max(120, Math.round(cssHeight));

      canvas.width = Math.max(1, Math.round(cssWidth * dpr));
      canvas.height = Math.max(1, Math.round(cssHeight * dpr));
      canvas.style.width = '100%';
      canvas.style.height = cssHeight + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const labels = this.data.labels || [];
      const datasets = this.data.datasets || [];
      if (!labels.length || !datasets.length) {
        ctx.fillStyle = '#9aa7b4';
        ctx.font = '13px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No data yet', cssWidth / 2, cssHeight / 2);
        return;
      }

      const scales = (this.chartOptions.scales) || {};
      const leftAxisId = Object.keys(scales).find((k) => k !== 'x' && (!scales[k].position || scales[k].position === 'left')) || 'y';
      const rightAxisId = Object.keys(scales).find((k) => k !== 'x' && scales[k].position === 'right');

      const isRightAxis = (ds) => !!rightAxisId && ds.yAxisID === rightAxisId;

      const leftValues = [];
      const rightValues = [];
      datasets.forEach((ds) => {
        const target = isRightAxis(ds) ? rightValues : leftValues;
        (ds.data || []).forEach((v) => { if (typeof v === 'number') target.push(v); });
      });
      const leftRange = axisRange(scales[leftAxisId], leftValues);
      const rightRange = rightAxisId ? axisRange(scales[rightAxisId], rightValues) : null;

      // Axis gutters scale down on narrow canvases so a 320px phone still
      // gets a usable plot area instead of 84px of it being axis labels.
      const narrow = cssWidth < 420;
      const padLeft = narrow ? 30 : 42;
      const padRight = rightAxisId ? (narrow ? 30 : 42) : 12;
      const padTop = 12;
      const padBottom = narrow ? 18 : 22;
      const plotW = Math.max(10, cssWidth - padLeft - padRight);
      const plotH = Math.max(10, cssHeight - padTop - padBottom);

      // gridlines + left axis labels
      ctx.strokeStyle = '#e4e9ed';
      ctx.fillStyle = '#8a97a3';
      ctx.font = (narrow ? '9px' : '10px') + ' "IBM Plex Mono", monospace';
      ctx.lineWidth = 1;
      const GRID_LINES = 4;
      for (let i = 0; i <= GRID_LINES; i++) {
        const y = padTop + (plotH * i) / GRID_LINES;
        ctx.beginPath();
        ctx.moveTo(padLeft, y + 0.5);
        ctx.lineTo(padLeft + plotW, y + 0.5);
        ctx.stroke();
        const val = leftRange.max - ((leftRange.max - leftRange.min) * i) / GRID_LINES;
        ctx.textAlign = 'right';
        ctx.fillText(Math.round(val * 10) / 10, padLeft - 6, y + 3);
        if (rightRange) {
          const rval = rightRange.max - ((rightRange.max - rightRange.min) * i) / GRID_LINES;
          ctx.textAlign = 'left';
          ctx.fillText(Math.round(rval), padLeft + plotW + 6, y + 3);
        }
      }

      // x-axis labels (subsampled)
      // Honour the configured maxTicksLimit, but never draw more labels than
      // the plot width can fit without them colliding (~46px per label).
      const configuredTicks = (scales.x && scales.x.ticks && scales.x.ticks.maxTicksLimit) || 8;
      const maxTicks = Math.max(3, Math.min(configuredTicks, Math.floor(plotW / 46)));
      const tickIdx = pickTickIndices(labels.length, maxTicks);
      ctx.textAlign = 'center';
      tickIdx.forEach((i) => {
        const x = labels.length > 1 ? padLeft + (plotW * i) / (labels.length - 1) : padLeft + plotW / 2;
        ctx.fillText(labels[i], x, cssHeight - 6);
      });

      const xFor = (i) => (labels.length > 1 ? padLeft + (plotW * i) / (labels.length - 1) : padLeft + plotW / 2);

      if (this.type === 'bar') {
        const groupCount = datasets.length;
        const slot = plotW / labels.length;
        const barW = Math.max(2, (slot * 0.62) / groupCount);
        datasets.forEach((ds, dIdx) => {
          const range = isRightAxis(ds) ? rightRange : leftRange;
          ctx.fillStyle = ds.backgroundColor || '#2e64a7';
          (ds.data || []).forEach((v, i) => {
            const yFrac = (v - range.min) / (range.max - range.min || 1);
            const barH = Math.max(0, yFrac * plotH);
            const groupStart = padLeft + slot * i + slot / 2 - (barW * groupCount) / 2;
            const x = groupStart + dIdx * barW;
            const y = padTop + plotH - barH;
            ctx.fillRect(x, y, barW - 1, barH);
          });
        });
      } else {
        // line chart(s)
        datasets.forEach((ds) => {
          const range = isRightAxis(ds) ? rightRange : leftRange;
          const pts = (ds.data || []).map((v, i) => [xFor(i), padTop + plotH - ((v - range.min) / (range.max - range.min || 1)) * plotH]);
          if (!pts.length) return;

          if (ds.fill) {
            ctx.beginPath();
            ctx.moveTo(pts[0][0], padTop + plotH);
            pts.forEach((p) => ctx.lineTo(p[0], p[1]));
            ctx.lineTo(pts[pts.length - 1][0], padTop + plotH);
            ctx.closePath();
            ctx.fillStyle = ds.backgroundColor || 'rgba(0,0,0,0.05)';
            ctx.fill();
          }

          ctx.beginPath();
          ctx.strokeStyle = ds.borderColor || '#2e64a7';
          ctx.lineWidth = ds.borderWidth || 2;
          ctx.setLineDash(ds.borderDash || []);
          pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
          ctx.stroke();
          ctx.setLineDash([]);
        });
      }

      // axis titles
      if (scales[leftAxisId] && scales[leftAxisId].title && scales[leftAxisId].title.display) {
        ctx.save();
        ctx.translate(narrow ? 8 : 11, padTop + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#6c7a89';
        ctx.font = '10px Inter, sans-serif';
        ctx.fillText(scales[leftAxisId].title.text, 0, 0);
        ctx.restore();
      }
      if (rightAxisId && scales[rightAxisId].title && scales[rightAxisId].title.display) {
        ctx.save();
        ctx.translate(cssWidth - (narrow ? 7 : 9), padTop + plotH / 2);
        ctx.rotate(Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#6c7a89';
        ctx.font = '10px Inter, sans-serif';
        ctx.fillText(scales[rightAxisId].title.text, 0, 0);
        ctx.restore();
      }
    }
  }

  global.Chart = MiniChart;
})(window);
