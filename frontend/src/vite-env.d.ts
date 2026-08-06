/// <reference types="vite/client" />

// noVNC ships no types. Only the handful of members the viewer touches are declared, so a
// typo in one of them is still caught rather than the whole module being `any`.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement | undefined, url: string, options?: Record<string, unknown>);
    scaleViewport: boolean;
    viewOnly: boolean;
    clipViewport: boolean;
    disconnect(): void;
  }
}
