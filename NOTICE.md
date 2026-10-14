# Third-party notices

Debrief Pro bundles two third-party components for local voice recognition.

## WeSpeaker speaker model (`extension/models/wespeaker_resnet34_lm.onnx`)
- ResNet34 speaker embedding model (VoxCeleb, large-margin fine-tuned) from the WeSpeaker project: <https://github.com/wenet-e2e/wespeaker>.
- Licensed under Creative Commons Attribution 4.0 (CC-BY-4.0). The model file is used unmodified apart from export to ONNX by the project.
- If you redistribute the extension, keep this notice. The model was trained on public speech data (VoxCeleb); see the WeSpeaker project for the data terms.

## ONNX Runtime Web (`extension/vendor/ort/`)
- ONNX Runtime Web (WebAssembly build), copyright Microsoft Corporation, MIT licence: <https://github.com/microsoft/onnxruntime>.
