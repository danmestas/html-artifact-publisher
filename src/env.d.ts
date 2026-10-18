// Built by fossil/build.sh; see src/fossil.ts.
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

// Defined by wasm_exec.js (Go's or TinyGo's runtime glue).
declare class Go {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}
