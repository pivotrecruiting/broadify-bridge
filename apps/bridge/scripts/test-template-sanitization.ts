import assert from "node:assert/strict";
import { sanitizeTemplateCss, validateTemplate } from "../src/services/graphics/template-sanitizer.js";

const html = `<div data-root="graphic" class="root">
  <div class="lt" data-animate>

    <div class="left">
      <div class="number-wrap">
        <div class="number" data-bid="value">89</div>
      </div>
      <div class="unit" data-bid="unit">PROZENT</div>
    </div>

    <div class="right">
      <div class="bar"></div>
      <div class="headline" data-bid="headline">Aller Unternehmen nutzen Video als Kommunikationsmittel</div>
      <div class="subline" data-bid="subline">Zahlen, Daten & Fakten</div>
    </div>

  </div>
</div>`;

const css = `.root{position:relative;width:100%;height:100%;font-family:var(--font-family);}

.lt{
  position:absolute;
  left:0;
  bottom:0;
  width:100%;
  height:var(--lt-height);
  display:flex;
  background:rgba(var(--bg),var(--bg-opacity));
}

/* LEFT BLOCK /
.left{
  width:var(--left-width);
  padding:var(--pad);
  display:flex;
  flex-direction:column;
  justify-content:center;
}

.number-wrap{overflow:hidden;height:var(--number-size);}

.number{
  font-size:var(--number-size);
  font-weight:900;
  color:var(--text-color);
  transform:translateY(120%);
  animation:numberIn var(--num-dur) cubic-bezier(.2,.8,.2,1) forwards;
}

@keyframes numberIn{
  0%{transform:translateY(120%)}
  60%{transform:translateY(-10%)}
  100%{transform:translateY(0)}
}

.unit{
  margin-top:6px;
  font-size:var(--unit-size);
  font-weight:700;
  letter-spacing:1px;
  color:var(--text-color);
}

/ RIGHT BLOCK */
.right{
  flex:1;
  padding:var(--pad);
  display:flex;
  flex-direction:column;
  justify-content:center;
}

.bar{
  width:0;
  height:var(--bar-height);
  background:linear-gradient(90deg,var(--bar-start),var(--bar-end));
  margin-bottom:14px;
  animation:barIn var(--bar-dur) ease-out forwards;
}

@keyframes barIn{to{width:var(--bar-width)}}

.headline{
  font-size:var(--headline-size);
  font-weight:800;
  line-height:1.2;
  color:var(--text-color);
}

.subline{
  margin-top:8px;
  font-size:var(--subline-size);
  color:rgba(255,255,255,0.75);
}`;

const sanitizedCss = sanitizeTemplateCss(css);

assert(sanitizedCss.length < css.length, "Sanitized CSS should be shorter");
assert(!sanitizedCss.includes("/*"), "Sanitized CSS should remove comment starts");
assert(!sanitizedCss.includes("*/"), "Sanitized CSS should remove comment ends");
assert(!sanitizedCss.includes("LEFT BLOCK"), "Sanitized CSS should strip comment text");
assert(!sanitizedCss.includes("RIGHT BLOCK"), "Sanitized CSS should strip comment text");
assert(sanitizedCss.includes(".root{"), "Sanitized CSS should preserve base rules");
assert(sanitizedCss.includes(".lt{"), "Sanitized CSS should preserve layout rules");
assert(!sanitizedCss.includes(".left{"), "Sanitized CSS should drop commented rules");
assert(sanitizedCss.includes(".right{"), "Sanitized CSS should preserve right block");
assert(sanitizedCss.includes("@keyframes barIn"), "Sanitized CSS should keep animations");

const cssWithStrings = `.a{content:"/* keep */";}
/* drop */
.b{content:"*/ keep */";}`;

const sanitizedWithStrings = sanitizeTemplateCss(cssWithStrings);
assert(
  sanitizedWithStrings.includes('content:"/* keep */"'),
  "Sanitized CSS should keep comment markers inside strings"
);
assert(
  sanitizedWithStrings.includes('content:"*/ keep */"'),
  "Sanitized CSS should keep closing markers inside strings"
);
assert(
  !sanitizedWithStrings.includes("drop"),
  "Sanitized CSS should remove standalone comments"
);

const cssUnclosed = `.a{color:red;}
/* unclosed comment
.b{color:blue;}`;

const sanitizedUnclosed = sanitizeTemplateCss(cssUnclosed);
assert(
  sanitizedUnclosed.includes(".a{color:red;}"),
  "Sanitized CSS should keep rules before unclosed comments"
);
assert(
  !sanitizedUnclosed.includes(".b{color:blue;}"),
  "Sanitized CSS should remove content after unclosed comments"
);

const validation = validateTemplate(html, sanitizedCss);
assert.equal(validation.assetIds.size, 0, "No assets expected in template");

console.log("Template sanitization test passed.");
