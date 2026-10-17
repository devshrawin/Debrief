# Third-party notices

Debrief Pro bundles two third-party components for local voice recognition.

## WeSpeaker speaker model (`extension/models/wespeaker_resnet34_lm.onnx`)
- ResNet34 speaker embedding model (VoxCeleb, large-margin fine-tuned) from the WeSpeaker project: <https://github.com/wenet-e2e/wespeaker>.
- Licensed under Creative Commons Attribution 4.0 International (CC-BY-4.0). The WeSpeaker project states that its pretrained models follow the licence of their training data: "The pretrained model on VoxCeleb follows Creative Commons Attribution 4.0 International License, since it is used as license of the VoxCeleb dataset." (<https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md>). Licence text: <https://creativecommons.org/licenses/by/4.0/>. Some third-party mirrors list other licences (Apache-2.0, MIT); those apply to the toolkit code or are mistakes, and this notice follows the project's own page. The model file is used unmodified apart from export to ONNX by the project.
- If you redistribute the extension, keep this notice. The model was trained on public speech data (VoxCeleb); see the WeSpeaker project for the data terms.

## ONNX Runtime Web (`extension/vendor/ort/`)
- ONNX Runtime Web (WebAssembly build), copyright Microsoft Corporation, MIT licence: <https://github.com/microsoft/onnxruntime>.
