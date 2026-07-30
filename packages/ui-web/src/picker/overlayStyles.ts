export const OVERLAY_STYLES = `@layer components {
  :host {
    all: initial;
    position: fixed;
    top: 0;
    left: 0;
    z-index: 2147483647;
  }
  * { box-sizing: border-box; }
  #boxes, #catcher {
    position: fixed;
    inset: 0;
    margin: 0;
  }
  #boxes { pointer-events: none; z-index: 1; }
  .box {
    position: absolute;
    pointer-events: none;
    border: 2px solid #3a76d0;
    background: rgba(58, 118, 208, 0.12);
    border-radius: 2px;
  }
  .box.field {
    border-color: #d07a3a;
    background: rgba(208, 122, 58, 0.18);
  }
  .box.hover {
    border-color: #2fa463;
    background: rgba(47, 164, 99, 0.18);
  }
  #catcher { z-index: 2; cursor: crosshair; display: none; }
  #catcher:not([hidden]) { display: block; }
  #hoverhint {
    position: fixed;
    z-index: 4;
    display: none;
    max-width: 60vw;
    padding: 3px 7px;
    font: 11px/1.4 Consolas, monospace;
    color: #e8eaf2;
    background: #20242f;
    border: 1px solid #3a76d0;
    border-radius: 3px;
    pointer-events: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #hoverhint:not([hidden]) { display: block; }
  #panel {
    position: fixed;
    right: 14px;
    bottom: 14px;
    z-index: 3;
    width: 380px;
    max-width: calc(100vw - 28px);
    max-height: calc(100vh - 28px);
    overflow: auto;
    font: 12px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #e8eaf2;
    background: #262a35;
    border: 1px solid #444b5d;
    border-radius: 6px;
    padding: 12px;
  }
  #panel h1 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 8px;
  }
  .row {
    display: grid;
    grid-template-columns: 52px 1fr auto auto;
    gap: 6px;
    align-items: center;
    margin-bottom: 6px;
  }
  .row label { color: #aab1c2; }
  .row input[type="text"] {
    width: 100%;
    min-width: 0;
    padding: 3px 6px;
    font: 11px Consolas, monospace;
    color: #e8eaf2;
    background: #1b1e26;
    border: 1px solid #444b5d;
    border-radius: 3px;
  }
  .row input[type="text"]:focus { outline: 1px solid #3a76d0; }
  .row .count {
    min-width: 26px;
    text-align: right;
    color: #8f97a8;
    font-variant-numeric: tabular-nums;
  }
  button {
    padding: 3px 9px;
    font: 11px -apple-system, "Segoe UI", sans-serif;
    color: #e8eaf2;
    background: #333a4a;
    border: 1px solid #4c5468;
    border-radius: 3px;
    cursor: pointer;
  }
  button:hover { background: #40495e; }
  button.picking { background: #3a76d0; border-color: #3a76d0; }
  button:disabled { opacity: 0.45; cursor: default; }
  #status {
    min-height: 16px;
    margin: 4px 0;
    color: #ffb37a;
    word-break: break-word;
  }
  #preview {
    margin-top: 6px;
    border-top: 1px solid #444b5d;
    padding-top: 6px;
  }
  #preview .summary { color: #8f97a8; margin-bottom: 6px; }
  #preview .story {
    padding: 4px 6px;
    margin-bottom: 4px;
    background: #1b1e26;
    border-radius: 3px;
  }
  #preview .story .t { color: #e8eaf2; }
  #preview .story .u, #preview .story .m {
    color: #8f97a8;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #source { margin-top: 6px; }
  #source label {
    display: block;
    color: #aab1c2;
    margin-bottom: 2px;
  }
  #source textarea {
    width: 100%;
    min-height: 48px;
    resize: vertical;
    padding: 4px 6px;
    font: 10px/1.5 Consolas, monospace;
    color: #e8eaf2;
    background: #1b1e26;
    border: 1px solid #444b5d;
    border-radius: 3px;
    word-break: break-all;
  }
  #source textarea:focus { outline: 1px solid #3a76d0; }
  #actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  #actions .save { background: #2fa463; border-color: #2fa463; }
  #actions .save:hover { background: #37b56f; }
}
`
