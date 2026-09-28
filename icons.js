(() => {
  const NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    "settings-2": '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    "search": '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    "plus": '<path d="M5 12h14"/><path d="M12 5v14"/>',
    "x": '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    "database": '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
    "check": '<path d="M20 6 9 17l-5-5"/>',
  };

  function createIcon(name, attrs = {}) {
    const body = ICONS[name];
    if (!body) return null;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    Object.entries(attrs).forEach(([key, value]) => svg.setAttribute(key, value));
    svg.innerHTML = body;
    return svg;
  }

  function createIcons({ attrs = {} } = {}) {
    document.querySelectorAll("i[data-lucide]").forEach(node => {
      const svg = createIcon(node.dataset.lucide, attrs);
      if (!svg) return;
      if (node.className) svg.setAttribute("class", node.className);
      node.replaceWith(svg);
    });
  }

  window.lucide = { createIcons };
})();
