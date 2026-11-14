/// <reference types="vite/client" />

declare module "@soundtouchjs/audio-worklet?url" {
  const src: string;
  export default src;
}

declare module "*?raw" {
  const content: string;
  export default content;
}


