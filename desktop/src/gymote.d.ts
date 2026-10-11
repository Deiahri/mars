// Hand-written types for gymote@1.0.0 (it ships none). `require('gymote')` is { GymoteRemote, GymoteScreen }.
// Members marked "internal" aren't documented but we need them to work around library bugs.

declare module 'gymote' {
  type Point = { x: number; y: number };

  /** Phone side: gyroscope → screen pixel, sent as an 8-byte Int16 [x, y, clicking, touchY]. */
  export class GymoteRemote {
    /** Internal. Gyroscope wrapper around gyronorm/FULLTILT. */
    gyroscope: {
      /** Internal cache behind deviceHasGyroscope(); null = not checked yet. */
      _hasGyroscope: boolean | null;
      needsPermission(): boolean;
      /** Starts reading. Gymote only calls this after an iOS permission prompt (Android bug). */
      initGyroNorm(): void;
      getOrientation(rounding?: number): { alpha: number; beta: number };
    };
    /** Called with the (reused) packet buffer whenever a value changes. */
    _onDataChange: (buf: ArrayBuffer) => void;
    requestGyroscopePermission(): Promise<boolean>;
    /** Resolves only after the gyroscope has been initialised. */
    deviceHasGyroscope(): Promise<boolean>;
    start(): void;
    stop(): void;
    /** Makes the current aim the centre of the screen. */
    calibrate(): void;
    updateClick(isClicking: boolean): void;
    /** Only `y` is sent; `x` is dropped. */
    updateTouch(touch: Point): void;
    updateScreenViewport(viewport: { width: number; height: number }): void;
    /** Phone-to-screen distance in screen pixels. Larger = the same turn sweeps more pixels (more sensitive). */
    updateScreenDistance(px: number): void;
  }

  type ScreenEvents = {
    pointermove: [Point];
    pointerdown: [];
    pointerup: [];
    touch: [Point];
    lagstart: [];
    lagend: [];
    calibrated: [];
  };

  /** Laptop side: feed it packets, it emits pointer events. */
  export class GymoteScreen {
    on<E extends keyof ScreenEvents>(event: E, fn: (...args: ScreenEvents[E]) => void): this;
    handleRemoteData(buf: ArrayBuffer): void;
  }

  const gymote: { GymoteRemote: typeof GymoteRemote; GymoteScreen: typeof GymoteScreen };
  export default gymote;
}
