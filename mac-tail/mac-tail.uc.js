// mac-panel-tail : ajoute une queue pointue aux panels de type "arrow"
(() => {
    const W = 20, H = 10, NS = "http://www.w3.org/2000/svg";
    const CSS = `
      .mac-tail { position:absolute; width:${W}px; height:${H}px; pointer-events:none; z-index:2; }
      .mac-tail svg { display:block; width:100%; height:100% }
      .mac-tail .fill { fill: var(--arrowpanel-background, Canvas); }
      .mac-tail .line { fill:none; stroke: var(--arrowpanel-border-color, ThreeDShadow); stroke-width:1; }
      .mac-tail.flip svg { transform: scaleY(-1); }
    `;
  
    function ensureTail(panel) {
      if (panel._macTail) return panel._macTail;
      const root = panel.openOrClosedShadowRoot || panel.shadowRoot;
      const content = root?.querySelector(".panel-arrowcontent");
      if (!content) return null;
      const doc = panel.ownerDocument;
      const style = doc.createElement("style");
      style.textContent = CSS;
      root.appendChild(style);
  
      const tail = doc.createElement("div");
      tail.className = "mac-tail";
      const svg = doc.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      for (const [cls, d] of [["fill", `M0 ${H} L${W/2} 0 L${W} ${H} Z`],
                              ["line", `M0 ${H} L${W/2} 0 L${W} ${H}`]]) {
        const p = doc.createElementNS(NS, "path");
        p.setAttribute("class", cls);
        p.setAttribute("d", d);
        svg.appendChild(p);
      }
      tail.appendChild(svg);
      content.style.position = "relative";
      content.appendChild(tail);
      return (panel._macTail = tail);
    }
  
    function place(panel) {
      const tail = ensureTail(panel);
      const anchor = panel.anchorNode;
      if (!tail || !anchor) return;
      const win = anchor.ownerGlobal;
      const a = anchor.getBoundingClientRect();
      const ax = win.mozInnerScreenX + a.left + a.width / 2;
      const ay = win.mozInnerScreenY + a.top + a.height / 2;
      const p = panel.getOuterScreenRect();
  
      const panelAbove = ay > p.y + p.height / 2;           // ancre sous le panel
      const x = Math.max(16, Math.min(p.width - 16, ax - p.x));
      tail.classList.toggle("flip", panelAbove);
      tail.style.left = `${x - W / 2}px`;
      tail.style.top = panelAbove ? `calc(100% - 1px)` : `${-(H - 1)}px`;
    }
  
    window.addEventListener("popupshown", (e) => {
      const t = e.target;
      if (t.localName === "panel" && t.getAttribute("type") === "arrow") place(t);
    }, true);
  })();