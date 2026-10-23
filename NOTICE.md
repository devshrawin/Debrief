# Third-party notices

Debrief Pro bundles two third-party components for local voice recognition.

## WeSpeaker speaker model (`extension/models/wespeaker_resnet34_lm.onnx`)
- ResNet34 speaker embedding model (VoxCeleb, large-margin fine-tuned) from the WeSpeaker project: <https://github.com/wenet-e2e/wespeaker>.
- Licensed under Creative Commons Attribution 4.0 International (CC-BY-4.0). The WeSpeaker project states that its pretrained models follow the licence of their training data: "The pretrained model on VoxCeleb follows Creative Commons Attribution 4.0 International License, since it is used as license of the VoxCeleb dataset." (<https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md>). Licence text: <https://creativecommons.org/licenses/by/4.0/>. Some third-party mirrors list other licences (Apache-2.0, MIT); those apply to the toolkit code or are mistakes, and this notice follows the project's own page. The model file is used unmodified apart from export to ONNX by the project.
- If you redistribute the extension, keep this notice. The model was trained on public speech data (VoxCeleb); see the WeSpeaker project for the data terms.

## ONNX Runtime Web (`extension/vendor/ort/`)
- ONNX Runtime Web (WebAssembly build), copyright Microsoft Corporation, MIT licence: <https://github.com/microsoft/onnxruntime>.

## Libraries.dev effects (`extension/fx/`, sources in `third_party/libraries-dev/`)
Parts of four React libraries by Jakub Antalik (https://github.com/Jakubantalik/Libraries.dev) are used without React, either vendored unchanged or ported to vanilla JavaScript:

- **thinking-orbs** 0.3.1: the React-free `engine` (dotted-orb geometry and canvas painter). Wrapped in a `<db-orb>` custom element. The cursor "gravity" module is not included.
- **border-beam** 1.4.0: `styles.ts` is run at build time to generate static CSS (`extension/fx/beam-*.css`). `pulseDriver.ts` ships unchanged.
- **liquid-gooey** 0.2.1: `spring.ts` is run at build time to compile spring easings into CSS `linear()` tokens. The goo selection thumb (`fx/src/goo.js`) is an original vanilla implementation of the library's Move idea.
- **metal-fx** 2.0.10: the React-free engine (renderer, presets, text mask) is wrapped in `fx/src/metal.js`. Cursor light and proximity reflections are not included.

Licence: MIT. Copyright (c) 2026 Jakub Antalik (liquid-gooey's licence reads "Copyright (c) 2026 Jakub"). The full licence texts are in `third_party/libraries-dev/*/LICENSE` and `extension/fx/LICENSES.txt`.

### metal-fx NOTICE (reproduced verbatim)
```
metal-fx
Copyright (c) Jakub Antalik

This product includes software developed by Paper Design, Inc.

  Paper Shaders (https://github.com/paper-design/shaders)
  Copyright (c) Paper Design, Inc.
  Licensed under the Apache License, Version 2.0
  http://www.apache.org/licenses/LICENSE-2.0

Specifically:

  * The `liquidMetal` fragment shader is consumed unmodified at build time
    from the `@paper-design/shaders` npm package and inlined into the
    distributed bundle. See src/engine/shaders.ts.

  * The sizing vertex shader in src/engine/shaders.ts (`VERT_SHADER_SRC`) is
    copied verbatim from `packages/shaders/src/vertex-shader.ts` @ 0.0.80.
    It is vendored rather than imported because the package exposes it only
    through `ShaderMount`, which owns its own canvas and animation loop.

No changes were made to either shader's source.
```
