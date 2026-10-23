// Liquid selection thumb for segmented controls and tab bars.
// A small vanilla port of liquid-gooey's "Move" idea: the surface is an SVG
// silhouette under the crisp, real buttons; a lead blob jumps to the new
// selection on the spring easing (generated from liquid-gooey's spring.ts into
// --spring) while a trailing blob follows more slowly, and a goo filter
// (blur + alpha contrast) merges them so the thumb stretches like liquid
// rubber and snaps back. Buttons stay real, focusable DOM; text is never
// filtered. Idle cost is zero: only CSS transitions run, and only on change.
let uid = 0;
const NS = 'http://www.w3.org/2000/svg';
const isActive = (b) => b.classList.contains('active') || b.getAttribute('aria-selected') === 'true' || b.getAttribute('aria-checked') === 'true';

export function gooSegmented(group) {
  if (!group || group.classList.contains('has-goo')) return;
  const buttons = () => [...group.children].filter((c) => c.tagName === 'BUTTON');
  if (!buttons().length) return;
  const id = `db-goo-${++uid}`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'goo-layer');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<defs><filter id="${id}" x="-20%" y="-50%" width="140%" height="200%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="b"/>
      <feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" result="goo"/>
      <feComposite in="SourceGraphic" in2="goo" operator="atop"/>
    </filter></defs>
    <g filter="url(#${id})"><rect class="goo-trail" rx="8"/><rect class="goo-lead" rx="8"/></g>`;
  if (getComputedStyle(group).position === 'static') group.style.position = 'relative';
  group.style.isolation = 'isolate';
  group.prepend(svg);
  group.classList.add('has-goo');
  const lead = svg.querySelector('.goo-lead');
  const trail = svg.querySelector('.goo-trail');
  for (const r of [lead, trail]) { r.style.fill = 'var(--goo-fill, var(--surface-read))'; }
  lead.style.transition = 'transform var(--d-base) var(--spring), width var(--d-base) var(--spring)';
  trail.style.transition = 'transform calc(var(--d-base) * 1.7) var(--spring-smooth), width calc(var(--d-base) * 1.7) var(--spring-smooth)';
  svg.style.filter = 'drop-shadow(0 1px 2px rgb(0 0 0 / .10)) drop-shadow(0 3px 8px rgb(0 0 0 / .06))';

  let first = true;
  const place = () => {
    const b = buttons().find(isActive);
    if (!b) { svg.style.opacity = '0'; return; }
    svg.style.opacity = '1';
    const gr = group.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    svg.setAttribute('width', String(gr.width)); svg.setAttribute('height', String(gr.height));
    const x = br.left - gr.left, y = br.top - gr.top;
    for (const r of [lead, trail]) {
      if (first) r.style.transitionDuration = '0s';
      r.style.width = `${br.width}px`;
      r.setAttribute('y', String(y)); r.setAttribute('height', String(br.height));
      r.style.transform = `translateX(${x}px)`;
    }
    trail.setAttribute('y', String(y + 2)); trail.setAttribute('height', String(Math.max(0, br.height - 4)));
    if (first) { first = false; requestAnimationFrame(() => { lead.style.transitionDuration = ''; trail.style.transitionDuration = ''; }); }
  };
  const mo = new MutationObserver(place);
  for (const b of buttons()) mo.observe(b, { attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-checked'] });
  new ResizeObserver(place).observe(group);
  place();
}
