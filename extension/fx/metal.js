/* Debrief fx layer. Effects ported from Libraries.dev by Jakub Antalik (MIT); metal shader by Paper Design, Inc. (Apache-2.0). See NOTICE.md. */
(()=>{function G(e){let t=e.replace("#","");(t.length===3||t.length===4)&&(t=t.split("").map(n=>n+n).join(""));let o=t.length>=8?parseInt(t.slice(6,8),16)/255:1;return[parseInt(t.slice(0,2),16)/255,parseInt(t.slice(2,4),16)/255,parseInt(t.slice(4,6),16)/255,o]}var Ce=0;var Ie=1;var B={colorBack:"#00000000",speed:1,repetition:1.5,softness:.05,shiftRed:.3,shiftBlue:.3,distortion:.1,contour:.4,angle:90,shape:Ce,scale:1,rotation:0,offsetX:0,offsetY:0,originX:.5,originY:.5,worldWidth:0,worldHeight:0,fit:Ie},Be={name:"chromatic",modes:{dark:{...B,colorTint:"#88ccff2e",shiftRed:.75,shiftBlue:.75,repetition:2,softness:.09,shaderOpacity:1},light:{...B,colorTint:"#66b0ff99",shiftRed:.6,shiftBlue:.6,shaderOpacity:1}}},Pe={name:"silver",modes:{dark:{...B,colorTint:"#ffffff66",shaderOpacity:.88},light:{...B,colorTint:"#ffffff40",shaderOpacity:1}}},Fe={name:"gold",modes:{dark:{...B,colorTint:"#ffcc55cc",speed:.85,shaderOpacity:.92},light:{...B,colorTint:"#f7d488aa",shaderOpacity:1}}},L={chromatic:Be,silver:Pe,gold:Fe};var K=`
#define TWO_PI 6.28318530718
#define PI 3.14159265358979323846
`,Z=`
vec2 rotate(vec2 uv, float th) {
  return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv;
}
`;var J=`
  color += 1. / 256. * (fract(sin(dot(.014 * gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453123) - .5);
`,ee=`
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1;
  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
      dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`;var O=`#version 300 es
precision mediump float;

uniform sampler2D u_image;
uniform float u_imageAspectRatio;

uniform vec2 u_resolution;
uniform float u_time;

uniform vec4 u_colorBack;
uniform vec4 u_colorTint;

uniform float u_softness;
uniform float u_repetition;
uniform float u_shiftRed;
uniform float u_shiftBlue;
uniform float u_distortion;
uniform float u_contour;
uniform float u_angle;

uniform float u_shape;
uniform bool u_isImage;

in vec2 v_objectUV;
in vec2 v_responsiveUV;
in vec2 v_responsiveBoxGivenSize;
in vec2 v_imageUV;

out vec4 fragColor;

${K}
${Z}
${ee}

float getColorChanges(float c1, float c2, float stripe_p, vec3 w, float blur, float bump, float tint) {

  float ch = mix(c2, c1, smoothstep(.0, 2. * blur, stripe_p));

  float border = w[0];
  ch = mix(ch, c2, smoothstep(border, border + 2. * blur, stripe_p));

  if (u_isImage == true) {
    bump = smoothstep(.2, .8, bump);
  }
  border = w[0] + .4 * (1. - bump) * w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2. * blur, stripe_p));

  border = w[0] + .5 * (1. - bump) * w[1];
  ch = mix(ch, c2, smoothstep(border, border + 2. * blur, stripe_p));

  border = w[0] + w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2. * blur, stripe_p));

  float gradient_t = (stripe_p - w[0] - w[1]) / w[2];
  float gradient = mix(c1, c2, smoothstep(0., 1., gradient_t));
  ch = mix(ch, gradient, smoothstep(border, border + .5 * blur, stripe_p));

  // Tint color is applied with color burn blending
  ch = mix(ch, 1. - min(1., (1. - ch) / max(tint, 0.0001)), u_colorTint.a);
  return ch;
}

float getImgFrame(vec2 uv, float th) {
  float frame = 1.;
  frame *= smoothstep(0., th, uv.y);
  frame *= 1.0 - smoothstep(1. - th, 1., uv.y);
  frame *= smoothstep(0., th, uv.x);
  frame *= 1.0 - smoothstep(1. - th, 1., uv.x);
  return frame;
}

float blurEdge3x3(sampler2D tex, vec2 uv, vec2 dudx, vec2 dudy, float radius, float centerSample) {
  vec2 texel = 1.0 / vec2(textureSize(tex, 0));
  vec2 r = radius * texel;

  float w1 = 1.0, w2 = 2.0, w4 = 4.0;
  float norm = 16.0;
  float sum = w4 * centerSample;

  sum += w2 * textureGrad(tex, uv + vec2(0.0, -r.y), dudx, dudy).r;
  sum += w2 * textureGrad(tex, uv + vec2(0.0, r.y), dudx, dudy).r;
  sum += w2 * textureGrad(tex, uv + vec2(-r.x, 0.0), dudx, dudy).r;
  sum += w2 * textureGrad(tex, uv + vec2(r.x, 0.0), dudx, dudy).r;

  sum += w1 * textureGrad(tex, uv + vec2(-r.x, -r.y), dudx, dudy).r;
  sum += w1 * textureGrad(tex, uv + vec2(r.x, -r.y), dudx, dudy).r;
  sum += w1 * textureGrad(tex, uv + vec2(-r.x, r.y), dudx, dudy).r;
  sum += w1 * textureGrad(tex, uv + vec2(r.x, r.y), dudx, dudy).r;

  return sum / norm;
}

float lst(float edge0, float edge1, float x) {
  return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
}

void main() {

  const float firstFrameOffset = 2.8;
  float t = .3 * (u_time + firstFrameOffset);

  vec2 uv = v_imageUV;
  vec2 dudx = dFdx(v_imageUV);
  vec2 dudy = dFdy(v_imageUV);
  vec4 img = textureGrad(u_image, uv, dudx, dudy);

  if (u_isImage == false) {
    uv = v_objectUV + .5;
    uv.y = 1. - uv.y;
  }

  float cycleWidth = u_repetition;
  float edge = 0.;
  float contOffset = 1.;

  vec2 rotatedUV = uv - vec2(.5);
  float angle = (-u_angle + 70.) * PI / 180.;
  float cosA = cos(angle);
  float sinA = sin(angle);
  rotatedUV = vec2(
  rotatedUV.x * cosA - rotatedUV.y * sinA,
  rotatedUV.x * sinA + rotatedUV.y * cosA
  ) + vec2(.5);

  if (u_isImage == true) {
    float edgeRaw = img.r;
    edge = blurEdge3x3(u_image, uv, dudx, dudy, 6., edgeRaw);
    edge = pow(edge, 1.6);
    edge *= mix(0.0, 1.0, smoothstep(0.0, 0.4, u_contour));
  } else {
    if (u_shape < 1.) {
      // full-fill on canvas
      vec2 borderUV = v_responsiveUV + .5;
      float ratio = v_responsiveBoxGivenSize.x / v_responsiveBoxGivenSize.y;
      vec2 mask = min(borderUV, 1. - borderUV);
      vec2 pixel_thickness = min(250. / v_responsiveBoxGivenSize, vec2(.5));
      float maskX = smoothstep(0.0, pixel_thickness.x, mask.x);
      float maskY = smoothstep(0.0, pixel_thickness.y, mask.y);
      maskX = pow(maskX, .25);
      maskY = pow(maskY, .25);
      edge = clamp(1. - maskX * maskY, 0., 1.);

      uv = v_responsiveUV;
      if (ratio > 1.) {
        uv.y /= ratio;
      } else {
        uv.x *= ratio;
      }
      uv += .5;
      uv.y = 1. - uv.y;

      cycleWidth *= 2.;
      contOffset = 1.5;

    } else if (u_shape < 2.) {
      // circle
      vec2 shapeUV = uv - .5;
      shapeUV *= .67;
      edge = pow(clamp(3. * length(shapeUV), 0., 1.), 18.);
    } else if (u_shape < 3.) {
      // daisy
      vec2 shapeUV = uv - .5;
      shapeUV *= 1.68;

      float r = length(shapeUV) * 2.;
      float a = atan(shapeUV.y, shapeUV.x) + .2;
      r *= (1. + .05 * sin(3. * a + 2. * t));
      float f = abs(cos(a * 3.));
      edge = smoothstep(f, f + .7, r);
      edge *= edge;

      uv *= .8;
      cycleWidth *= 1.6;

    } else if (u_shape < 4.) {
      // diamond
      vec2 shapeUV = uv - .5;
      shapeUV = rotate(shapeUV, .25 * PI);
      shapeUV *= 1.42;
      shapeUV += .5;
      vec2 mask = min(shapeUV, 1. - shapeUV);
      vec2 pixel_thickness = vec2(.15);
      float maskX = smoothstep(0.0, pixel_thickness.x, mask.x);
      float maskY = smoothstep(0.0, pixel_thickness.y, mask.y);
      maskX = pow(maskX, .25);
      maskY = pow(maskY, .25);
      edge = clamp(1. - maskX * maskY, 0., 1.);
    } else if (u_shape < 5.) {
      // metaballs
      vec2 shapeUV = uv - .5;
      shapeUV *= 1.3;
      edge = 0.;
      for (int i = 0; i < 5; i++) {
        float fi = float(i);
        float speed = 1.5 + 2./3. * sin(fi * 12.345);
        float angle = -fi * 1.5;
        vec2 dir1 = vec2(cos(angle), sin(angle));
        vec2 dir2 = vec2(cos(angle + 1.57), sin(angle + 1.));
        vec2 traj = .4 * (dir1 * sin(t * speed + fi * 1.23) + dir2 * cos(t * (speed * 0.7) + fi * 2.17));
        float d = length(shapeUV + traj);
        edge += pow(1.0 - clamp(d, 0.0, 1.0), 4.0);
      }
      edge = 1. - smoothstep(.65, .9, edge);
      edge = pow(edge, 4.);
    }

    edge = mix(smoothstep(.9 - 2. * fwidth(edge), .9, edge), edge, smoothstep(0.0, 0.4, u_contour));

  }

  float opacity = 0.;
  if (u_isImage == true) {
    opacity = img.g;
    float frame = getImgFrame(v_imageUV, 0.);
    opacity *= frame;
  } else {
    opacity = 1. - smoothstep(.9 - 2. * fwidth(edge), .9, edge);
    if (u_shape < 2.) {
      edge = 1.2 * edge;
    } else if (u_shape < 5.) {
      edge = 1.8 * pow(edge, 1.5);
    }
  }

  float diagBLtoTR = rotatedUV.x - rotatedUV.y;
  float diagTLtoBR = rotatedUV.x + rotatedUV.y;

  vec3 color = vec3(0.);
  vec3 color1 = vec3(.98, 0.98, 1.);
  vec3 color2 = vec3(.1, .1, .1 + .1 * smoothstep(.7, 1.3, diagTLtoBR));

  vec2 grad_uv = uv - .5;

  float dist = length(grad_uv + vec2(0., .2 * diagBLtoTR));
  grad_uv = rotate(grad_uv, (.25 - .2 * diagBLtoTR) * PI);
  float direction = grad_uv.x;

  float bump = pow(1.8 * dist, 1.2);
  bump = 1. - bump;
  bump *= pow(uv.y, .3);


  float thin_strip_1_ratio = .12 / cycleWidth * (1. - .4 * bump);
  float thin_strip_2_ratio = .07 / cycleWidth * (1. + .4 * bump);
  float wide_strip_ratio = (1. - thin_strip_1_ratio - thin_strip_2_ratio);

  float thin_strip_1_width = cycleWidth * thin_strip_1_ratio;
  float thin_strip_2_width = cycleWidth * thin_strip_2_ratio;

  float noise = snoise(uv - t);

  edge += (1. - edge) * u_distortion * noise;

  direction += diagBLtoTR;
  float contour = 0.;
  direction -= 2. * noise * diagBLtoTR * (smoothstep(0., 1., edge) * (1.0 - smoothstep(0., 1., edge)));
  direction *= mix(1., 1. - edge, smoothstep(.5, 1., u_contour));
  direction -= 1.7 * edge * smoothstep(.5, 1., u_contour);
  direction += .2 * pow(u_contour, 4.) * (1.0 - smoothstep(0., 1., edge));

  bump *= clamp(pow(uv.y, .1), .3, 1.);
  direction *= (.1 + (1.1 - edge) * bump);

  direction *= (.4 + .6 * (1.0 - smoothstep(.5, 1., edge)));
  direction += .18 * (smoothstep(.1, .2, uv.y) * (1.0 - smoothstep(.2, .4, uv.y)));
  direction += .03 * (smoothstep(.1, .2, 1. - uv.y) * (1.0 - smoothstep(.2, .4, 1. - uv.y)));

  direction *= (.5 + .5 * pow(uv.y, 2.));
  direction *= cycleWidth;
  direction -= t;


  float colorDispersion = (1. - bump);
  colorDispersion = clamp(colorDispersion, 0., 1.);
  float dispersionRed = colorDispersion;
  dispersionRed += .03 * bump * noise;
  dispersionRed += 5. * (smoothstep(-.1, .2, uv.y) * (1.0 - smoothstep(.1, .5, uv.y))) * (smoothstep(.4, .6, bump) * (1.0 - smoothstep(.4, 1., bump)));
  dispersionRed -= diagBLtoTR;

  float dispersionBlue = colorDispersion;
  dispersionBlue *= 1.3;
  dispersionBlue += (smoothstep(0., .4, uv.y) * (1.0 - smoothstep(.1, .8, uv.y))) * (smoothstep(.4, .6, bump) * (1.0 - smoothstep(.4, .8, bump)));
  dispersionBlue -= .2 * edge;

  dispersionRed *= (u_shiftRed / 20.);
  dispersionBlue *= (u_shiftBlue / 20.);

  float blur = 0.;
  float rExtraBlur = 0.;
  float gExtraBlur = 0.;
  if (u_isImage == true) {
    float softness = 0.05 * u_softness;
    blur = softness + .5 * smoothstep(1., 10., u_repetition) * smoothstep(.0, 1., edge);
    float smallCanvasT = 1.0 - smoothstep(100., 500., min(u_resolution.x, u_resolution.y));
    blur += smallCanvasT * smoothstep(.0, 1., edge);
    rExtraBlur = softness * (0.05 + .1 * (u_shiftRed / 20.) * bump);
    gExtraBlur = softness * 0.05 / max(0.001, abs(1. - diagBLtoTR));
  } else {
    blur = u_softness / 15. + .3 * contour;
  }

  vec3 w = vec3(thin_strip_1_width, thin_strip_2_width, wide_strip_ratio);
  w[1] -= .02 * smoothstep(.0, 1., edge + bump);
  float stripe_r = fract(direction + dispersionRed);
  float r = getColorChanges(color1.r, color2.r, stripe_r, w, blur + fwidth(stripe_r) + rExtraBlur, bump, u_colorTint.r);
  float stripe_g = fract(direction);
  float g = getColorChanges(color1.g, color2.g, stripe_g, w, blur + fwidth(stripe_g) + gExtraBlur, bump, u_colorTint.g);
  float stripe_b = fract(direction - dispersionBlue);
  float b = getColorChanges(color1.b, color2.b, stripe_b, w, blur + fwidth(stripe_b), bump, u_colorTint.b);

  color = vec3(r, g, b);
  color *= opacity;

  vec3 bgColor = u_colorBack.rgb * u_colorBack.a;
  color = color + bgColor * (1. - opacity);
  opacity = opacity + u_colorBack.a * (1. - opacity);

  ${J}

  fragColor = vec4(color, opacity);
}
`;var te=`#version 300 es
precision mediump float;

layout(location = 0) in vec4 a_position;

uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_imageAspectRatio;
uniform float u_originX;
uniform float u_originY;
uniform float u_worldWidth;
uniform float u_worldHeight;
uniform float u_fit;
uniform float u_scale;
uniform float u_rotation;
uniform float u_offsetX;
uniform float u_offsetY;

out vec2 v_objectUV;
out vec2 v_objectBoxSize;
out vec2 v_responsiveUV;
out vec2 v_responsiveBoxGivenSize;
out vec2 v_patternUV;
out vec2 v_patternBoxSize;
out vec2 v_imageUV;

vec3 getBoxSize(float boxRatio, vec2 givenBoxSize) {
  vec2 box = vec2(0.);
  // fit = none
  box.x = boxRatio * min(givenBoxSize.x / boxRatio, givenBoxSize.y);
  float noFitBoxWidth = box.x;
  if (u_fit == 1.) { // fit = contain
    box.x = boxRatio * min(u_resolution.x / boxRatio, u_resolution.y);
  } else if (u_fit == 2.) { // fit = cover
    box.x = boxRatio * max(u_resolution.x / boxRatio, u_resolution.y);
  }
  box.y = box.x / boxRatio;
  return vec3(box, noFitBoxWidth);
}

void main() {
  gl_Position = a_position;

  vec2 uv = gl_Position.xy * .5;
  vec2 boxOrigin = vec2(.5 - u_originX, u_originY - .5);
  vec2 givenBoxSize = vec2(u_worldWidth, u_worldHeight);
  givenBoxSize = max(givenBoxSize, vec2(1.)) * u_pixelRatio;
  float r = u_rotation * 3.14159265358979323846 / 180.;
  mat2 graphicRotation = mat2(cos(r), sin(r), -sin(r), cos(r));
  vec2 graphicOffset = vec2(-u_offsetX, u_offsetY);


  // ===================================================

  float fixedRatio = 1.;
  vec2 fixedRatioBoxGivenSize = vec2(
  (u_worldWidth == 0.) ? u_resolution.x : givenBoxSize.x,
  (u_worldHeight == 0.) ? u_resolution.y : givenBoxSize.y
  );

  v_objectBoxSize = getBoxSize(fixedRatio, fixedRatioBoxGivenSize).xy;
  vec2 objectWorldScale = u_resolution.xy / v_objectBoxSize;

  v_objectUV = uv;
  v_objectUV *= objectWorldScale;
  v_objectUV += boxOrigin * (objectWorldScale - 1.);
  v_objectUV += graphicOffset;
  v_objectUV /= u_scale;
  v_objectUV = graphicRotation * v_objectUV;

  // ===================================================

  v_responsiveBoxGivenSize = vec2(
  (u_worldWidth == 0.) ? u_resolution.x : givenBoxSize.x,
  (u_worldHeight == 0.) ? u_resolution.y : givenBoxSize.y
  );
  float responsiveRatio = v_responsiveBoxGivenSize.x / v_responsiveBoxGivenSize.y;
  vec2 responsiveBoxSize = getBoxSize(responsiveRatio, v_responsiveBoxGivenSize).xy;
  vec2 responsiveBoxScale = u_resolution.xy / responsiveBoxSize;

  v_responsiveUV = uv;
  v_responsiveUV *= responsiveBoxScale;
  v_responsiveUV += boxOrigin * (responsiveBoxScale - 1.);
  v_responsiveUV += graphicOffset;
  v_responsiveUV /= u_scale;
  v_responsiveUV.x *= responsiveRatio;
  v_responsiveUV = graphicRotation * v_responsiveUV;
  v_responsiveUV.x /= responsiveRatio;

  // ===================================================

  float patternBoxRatio = givenBoxSize.x / givenBoxSize.y;
  vec2 patternBoxGivenSize = vec2(
  (u_worldWidth == 0.) ? u_resolution.x : givenBoxSize.x,
  (u_worldHeight == 0.) ? u_resolution.y : givenBoxSize.y
  );
  patternBoxRatio = patternBoxGivenSize.x / patternBoxGivenSize.y;

  vec3 boxSizeData = getBoxSize(patternBoxRatio, patternBoxGivenSize);
  v_patternBoxSize = boxSizeData.xy;
  float patternBoxNoFitBoxWidth = boxSizeData.z;
  vec2 patternBoxScale = u_resolution.xy / v_patternBoxSize;

  v_patternUV = uv;
  v_patternUV += graphicOffset / patternBoxScale;
  v_patternUV += boxOrigin;
  v_patternUV -= boxOrigin / patternBoxScale;
  v_patternUV *= u_resolution.xy;
  v_patternUV /= u_pixelRatio;
  if (u_fit > 0.) {
    v_patternUV *= (patternBoxNoFitBoxWidth / v_patternBoxSize.x);
  }
  v_patternUV /= u_scale;
  v_patternUV = graphicRotation * v_patternUV;
  v_patternUV += boxOrigin / patternBoxScale;
  v_patternUV -= boxOrigin;
  // x100 is a default multiplier between vertex and fragmant shaders
  // we use it to avoid UV presision issues
  v_patternUV *= .01;

  // ===================================================

  vec2 imageBoxSize;
  if (u_fit == 1.) { // contain
    imageBoxSize.x = min(u_resolution.x / u_imageAspectRatio, u_resolution.y) * u_imageAspectRatio;
  } else if (u_fit == 2.) { // cover
    imageBoxSize.x = max(u_resolution.x / u_imageAspectRatio, u_resolution.y) * u_imageAspectRatio;
  } else {
    imageBoxSize.x = min(10.0, 10.0 / u_imageAspectRatio * u_imageAspectRatio);
  }
  imageBoxSize.y = imageBoxSize.x / u_imageAspectRatio;
  vec2 imageBoxScale = u_resolution.xy / imageBoxSize;

  v_imageUV = uv;
  v_imageUV *= imageBoxScale;
  v_imageUV += boxOrigin * (imageBoxScale - 1.);
  v_imageUV += graphicOffset;
  v_imageUV /= u_scale;
  v_imageUV.x *= u_imageAspectRatio;
  v_imageUV = graphicRotation * v_imageUV;
  v_imageUV.x /= u_imageAspectRatio;

  v_imageUV += .5;
  v_imageUV.y = 1. - v_imageUV.y;
}`,oe=O;function D(e,t,o){let n=e.createShader(t);if(!n)throw new Error("metal-fx: gl.createShader returned null");if(e.shaderSource(n,o),e.compileShader(n),!e.getShaderParameter(n,e.COMPILE_STATUS)){let r=e.getShaderInfoLog(n);throw e.deleteShader(n),new Error(`metal-fx: shader compile failed: ${r??"(no info log)"}`)}return n}function re(e,t,o){let n=e.createProgram();if(!n)throw new Error("metal-fx: gl.createProgram returned null");if(e.attachShader(n,t),e.attachShader(n,o),e.linkProgram(n),!e.getProgramParameter(n,e.LINK_STATUS)){let r=e.getProgramInfoLog(n);throw e.deleteProgram(n),new Error(`metal-fx: program link failed: ${r??"(no info log)"}`)}return n}var W=140,V=40,z=1.6,H=1.3,i=null,P=null;function ie(){if(P!==null)return P;if(typeof document>"u")return P=!1;try{let t=document.createElement("canvas").getContext("webgl2");P=!!t,t?.getExtension("WEBGL_lose_context")?.loseContext()}catch{P=!1}return P}var ae=null;function se(e){ae=e}var Te=["u_resolution","u_time","u_pixelRatio","u_colorBack","u_colorTint","u_repetition","u_softness","u_shiftRed","u_shiftBlue","u_distortion","u_contour","u_angle","u_shape","u_isImage","u_image","u_originX","u_originY","u_worldWidth","u_worldHeight","u_fit","u_scale","u_rotation","u_offsetX","u_offsetY","u_imageAspectRatio"];function ne(e){e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA);let t=D(e,e.VERTEX_SHADER,te),o=D(e,e.FRAGMENT_SHADER,oe),n=re(e,t,o);e.useProgram(n);let r=e.createBuffer();if(!r)throw new Error("metal-fx: gl.createBuffer returned null");e.bindBuffer(e.ARRAY_BUFFER,r),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),e.STATIC_DRAW);let u=e.getAttribLocation(n,"a_position");e.enableVertexAttribArray(u),e.vertexAttribPointer(u,2,e.FLOAT,!1,0,0);let l={};for(let c of Te)l[c]=e.getUniformLocation(n,c);let s=e.createTexture();return s&&(e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,s),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,1,1,0,e.RGBA,e.UNSIGNED_BYTE,new Uint8Array([0,0,0,255])),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),l.u_image&&e.uniform1i(l.u_image,0)),{program:n,buffer:r,uniforms:l,dummyTexture:s}}function N(){if(i)return i;let e=Math.min(2,typeof window<"u"&&window.devicePixelRatio||1),t=Math.round(96*e),o=typeof OffscreenCanvas<"u",n,r;if(o)n=new OffscreenCanvas(t,t),r=n.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1});else{let d=document.createElement("canvas");d.width=t,d.height=t,r=d.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1,preserveDrawingBuffer:!0}),n=d}if(!r)throw new Error("metal-fx: WebGL2 not supported");let{program:u,buffer:l,uniforms:s,dummyTexture:c}=ne(r),m=d=>{d.preventDefault(),i&&(i.contextLost=!0)},x=()=>{if(!i)return;let d=ne(i.gl);i.program=d.program,i.buffer=d.buffer,i.uniforms=d.uniforms,i.dummyTexture=d.dummyTexture,i.presetDirty=!0,i.contextLost=!1,ae?.()};return n.addEventListener("webglcontextlost",m,!1),n.addEventListener("webglcontextrestored",x,!1),i={glCanvas:n,gl:r,program:u,buffer:l,uniforms:s,dummyTexture:c,preset:L.chromatic.modes.dark,presetDirty:!0,contextLost:!1,useOffscreen:o,frameBitmap:null,startMs:performance.now(),pausedMs:0,pausedAtMs:null,rafId:0,dpr:e,instances:new Set,frameCount:0,glowQueue:[],glowIdx:0,glowSkip:0,glowPixels:new Uint8Array(t*t*4),glowPixelsW:t,glowPixelsH:t},i}function le(){if(!i)return;let{gl:e,program:t,buffer:o,frameBitmap:n,dummyTexture:r}=i;try{n?.close(),e.deleteBuffer(o),e.deleteProgram(t),r&&e.deleteTexture(r),e.getExtension("WEBGL_lose_context")?.loseContext()}catch{}i=null}var ue=0;function ce(){if(!i)return;let e=performance.now();if(e-ue<1500)return;ue=e;let{gl:t,glCanvas:o}=i,n=o.width,r=o.height;(i.glowPixelsW!==n||i.glowPixelsH!==r)&&(i.glowPixelsW=n,i.glowPixelsH=r,i.glowPixels=new Uint8Array(n*r*4)),t.readPixels(0,0,n,r,t.RGBA,t.UNSIGNED_BYTE,i.glowPixels)}var $={x:0,y:0};function X(e=512){return{xy:new Float32Array(e*2),n:0}}function de(e,t,o,n,r,u,l=X()){r=Math.max(0,Math.min(r,Math.min(o,n)/2));let s=60+Math.ceil(2*(o+n)/1.5)+8;l.xy.length<s*2&&(l.xy=new Float32Array(s*2));let c=l.xy,m=0,x=(v,y)=>{u?(u(v,y,$),c[m*2]=$.x,c[m*2+1]=$.y):(c[m*2]=v,c[m*2+1]=y),m++},d=(v,y,R,b)=>{let a=Math.hypot(R-v,b-y),_=Math.max(1,Math.ceil(a/1.5));for(let f=0;f<_;f++){let w=f/_;x(v+(R-v)*w,y+(b-y)*w)}},h=(v,y,R,b)=>{for(let a=0;a<=14;a++){let _=R+(b-R)*(a/14);x(v+r*Math.cos(_),y+r*Math.sin(_))}};return d(e+r,t,e+o-r,t),h(e+o-r,t+r,-Math.PI/2,0),d(e+o,t+r,e+o,t+n-r),h(e+o-r,t+n-r,0,Math.PI/2),d(e+o-r,t+n,e+r,t+n),h(e+r,t+n-r,Math.PI/2,Math.PI),d(e,t+n-r,e,t+r),h(e+r,t+r,Math.PI,1.5*Math.PI),l.n=m,l}se(()=>{i&&i.instances.size>0&&i.pausedAtMs===null&&U()});typeof document<"u"&&document.addEventListener("visibilitychange",()=>{!i||i.pausedAtMs!==null||i.contextLost||(document.hidden?ve():i.instances.size>0&&U())});function fe(e){let t=N(),o=e.hostCanvas.getContext("2d",{alpha:!0});if(!o)throw new Error("metal-fx: canvas 2D context unavailable");let n=e.scale??1,r={canvas:e.hostCanvas,ctx:o,cssWidth:e.cssWidth,cssHeight:e.cssHeight,cornerRadius:e.cornerRadius,kind:e.kind,ringCssPx:e.ringCssPx??(e.kind==="circle"?2:1)*n,shaderScale:e.shaderScale??(e.kind==="circle"?H:z)*n,opacityMul:e.opacityMul??1,glowGain:e.glowGain??1,visible:!0,paused:e.paused??!1,everCopied:!1,frozen:null,dpr:typeof window<"u"&&window.devicePixelRatio||1,scale:n,onAfterFrame:e.onAfterFrame,onComposite:e.onComposite,onFirstCopy:e.onFirstCopy,mask:e.mask??null,deform:null,deformLayers:null,overscan:0,cursorLight:null,glowFast:!1,rawCanvas:null,wantRaw:!1,ringCanvas:null,wantRing:!1};return ge(r),t.instances.add(r),t.rafId===0&&t.pausedAtMs===null&&U(),r}function pe(e){if(!i)return;i.instances.delete(e);let t=i.glowQueue.indexOf(e);t!==-1&&i.glowQueue.splice(t,1),i.instances.size===0&&(ve(),le())}function Y(e,t){let o=!1;t.mask!==void 0&&(e.mask=t.mask),t.cssWidth!==void 0&&t.cssWidth!==e.cssWidth&&(e.cssWidth=t.cssWidth,o=!0),t.cssHeight!==void 0&&t.cssHeight!==e.cssHeight&&(e.cssHeight=t.cssHeight,o=!0),t.cornerRadius!==void 0&&(e.cornerRadius=t.cornerRadius),t.scale!==void 0&&(e.scale=t.scale),t.kind!==void 0&&t.kind!==e.kind&&(e.kind=t.kind,t.shaderScale===void 0&&(e.shaderScale=(t.kind==="circle"?H:z)*e.scale),t.ringCssPx===void 0&&(e.ringCssPx=(t.kind==="circle"?2:1)*e.scale)),t.shaderScale!==void 0&&(e.shaderScale=t.shaderScale),t.ringCssPx!==void 0&&(e.ringCssPx=t.ringCssPx),t.opacityMul!==void 0&&(e.opacityMul=t.opacityMul),t.glowGain!==void 0&&(e.glowGain=t.glowGain),t.paused!==void 0&&t.paused!==e.paused&&(e.paused=t.paused,t.paused?xe(e):e.frozen=null,!t.paused&&i&&i.rafId===0&&i.pausedAtMs===null&&!i.contextLost&&U()),o&&ge(e)}var Ee=null;function j(e,t){let o=N();o.preset=Ee??L[e].modes[t],o.presetDirty=!0}var k=null;function ge(e){e.dpr=typeof window<"u"&&window.devicePixelRatio||1;let t=e.overscan,o=Math.max(1,Math.round((e.cssWidth+2*t)*e.dpr)),n=Math.max(1,Math.round((e.cssHeight+2*t)*e.dpr));e.canvas.width!==o&&(e.canvas.width=o),e.canvas.height!==n&&(e.canvas.height=n);let r=e.canvas.style;t>0?(r.left=`${-t}px`,r.top=`${-t}px`,r.width=`calc(100% + ${2*t}px)`,r.height=`calc(100% + ${2*t}px)`,r.borderRadius="0"):r.left!==""&&(r.left="",r.top="",r.width="100%",r.height="100%",r.borderRadius="")}function Ae(e){let{ctx:t,dpr:o,canvas:n}=e,r=e.ringCssPx*o,u=n.width,l=n.height,s=Math.max(0,(e.cornerRadius-e.ringCssPx)*o);t.save(),t.globalCompositeOperation="destination-out",t.fillStyle="#000",t.beginPath(),t.roundRect(r,r,u-2*r,l-2*r,s),t.fill(),t.restore()}var Le=X();function C(e,t,o,n,r,u,l,s){let{xy:c,n:m}=de(t,o,n,r,u,l,Le);e.beginPath();for(let x=0;x<m;x++)x===0?e.moveTo(c[0]*s,c[1]*s):e.lineTo(c[x*2]*s,c[x*2+1]*s);e.closePath()}function xe(e){if(!i)return null;let t=i.frameBitmap??i.glCanvas,o=i.glCanvas.width,n=i.glCanvas.height;if(o<1||n<1)return null;let r=e.frozen;r||(r=document.createElement("canvas"),e.frozen=r),(r.width!==o||r.height!==n)&&(r.width=o,r.height=n);let u=r.getContext("2d");return u?(u.clearRect(0,0,o,n),u.drawImage(t,0,0),r):(e.frozen=null,null)}function ke(e){if(!i)return;let t=(e.paused?e.frozen??xe(e):null)??i.frameBitmap??i.glCanvas,o=e.dpr,n=e.canvas.width,r=e.canvas.height;if(n<1||r<1)return;let u=Math.max(1,Math.round(e.cssWidth*o)),l=Math.max(1,Math.round(e.cssHeight*o)),s=e.overscan*o,c=t.width,m=t.height,x=W*o,d=V*o,h=u*(c/x)/e.shaderScale,v=l*(m/d)/e.shaderScale;h>c&&(h=c),v>m&&(v=m);let y=Math.max(0,(c-h)/2),R=Math.max(0,(m-v)/2),b=e.opacityMul*i.preset.shaderOpacity,a=e.ctx;a.clearRect(0,0,n,r);let _=e.deform;if(e.mask){if(b<1&&(a.globalAlpha=b),a.drawImage(t,y,R,h,v,0,0,n,r),b<1&&(a.globalAlpha=1),e.wantRaw){let f=e.rawCanvas;f||(f=document.createElement("canvas"),e.rawCanvas=f),(f.width!==n||f.height!==r)&&(f.width=n,f.height=r);let w=f.getContext("2d");w&&(w.clearRect(0,0,n,r),w.drawImage(e.canvas,0,0))}a.save(),a.globalCompositeOperation="destination-in",a.fillStyle="#000",e.mask(a,n,r,o),a.restore(),a.globalCompositeOperation="source-over"}else if(!_)b<1&&(a.globalAlpha=b),a.drawImage(t,y,R,h,v,0,0,n,r),b<1&&(a.globalAlpha=1),Ae(e);else{let f=e.cssWidth,w=e.cssHeight,M=e.cornerRadius,S=e.ringCssPx,I=e.deformLayers;a.save(),a.translate(s,s);let Re=u/h,Me=l/v,F=Math.min(c,h*(u+2*s)/u),T=Math.min(m,v*(l+2*s)/l),Q=Math.max(0,(c-F)/2),q=Math.max(0,(m-T)/2),E=F*Re,A=T*Me;if(b<1&&(a.globalAlpha=b),a.drawImage(t,Q,q,F,T,u/2-E/2,l/2-A/2,E,A),b<1&&(a.globalAlpha=1),a.globalCompositeOperation="destination-in",C(a,0,0,f,w,M,_,o),a.fillStyle="#000",a.fill(),a.globalCompositeOperation="destination-out",C(a,S,S,f-2*S,w-2*S,Math.max(0,M-S),_,o),a.fill(),e.wantRing){let p=e.ringCanvas;p||(p=document.createElement("canvas"),e.ringCanvas=p),(p.width!==n||p.height!==r)&&(p.width=n,p.height=r);let g=p.getContext("2d");g&&(g.setTransform(1,0,0,1,0,0),g.globalCompositeOperation="source-over",g.clearRect(0,0,n,r),g.translate(s,s),b<1&&(g.globalAlpha=b),g.drawImage(t,Q,q,F,T,u/2-E/2,l/2-A/2,E,A),g.globalAlpha=1,g.globalCompositeOperation="destination-out",C(g,S,S,f-2*S,w-2*S,Math.max(0,M-S),_,o),g.fillStyle="#000",g.fill(),g.globalCompositeOperation="source-over",g.setTransform(1,0,0,1,0,0))}if(I?.hairline){let p=I.hairline;a.globalCompositeOperation="destination-over",C(a,p.inset,p.inset,f-2*p.inset,w-2*p.inset,Math.max(0,M-p.inset),_,o),a.lineWidth=p.width*o,a.strokeStyle=p.color,a.stroke()}if(I?.fill&&(a.globalCompositeOperation="destination-over",C(a,0,0,f,w,M,_,o),a.fillStyle=I.fill,a.fill()),I?.rim){let p=I.rim;a.globalCompositeOperation="source-over",a.save(),C(a,0,0,f,w,M,_,o),a.clip();let g=p.inset+p.width/2;C(a,g,g,f-2*g,w-2*g,Math.max(0,M-g),_,o),a.lineWidth=p.width*o,a.strokeStyle=p.color,a.stroke(),a.restore()}a.restore(),a.globalCompositeOperation="source-over"}if(e.onComposite?.(),e.onFirstCopy){let f=e.onFirstCopy;e.onFirstCopy=void 0,f()}e.onAfterFrame?.()}function Ue(){if(!i)return;let{gl:e,uniforms:t,preset:o,glCanvas:n,dpr:r}=i;t.u_resolution&&e.uniform2f(t.u_resolution,n.width,n.height),t.u_pixelRatio&&e.uniform1f(t.u_pixelRatio,r),t.u_colorBack&&e.uniform4fv(t.u_colorBack,G(o.colorBack)),t.u_colorTint&&e.uniform4fv(t.u_colorTint,G(o.colorTint)),t.u_repetition&&e.uniform1f(t.u_repetition,o.repetition),t.u_softness&&e.uniform1f(t.u_softness,o.softness),t.u_shiftRed&&e.uniform1f(t.u_shiftRed,o.shiftRed),t.u_shiftBlue&&e.uniform1f(t.u_shiftBlue,o.shiftBlue),t.u_distortion&&e.uniform1f(t.u_distortion,o.distortion),t.u_contour&&e.uniform1f(t.u_contour,o.contour),t.u_angle&&e.uniform1f(t.u_angle,o.angle),t.u_shape&&e.uniform1f(t.u_shape,o.shape),t.u_isImage&&e.uniform1i(t.u_isImage,0),t.u_imageAspectRatio&&e.uniform1f(t.u_imageAspectRatio,1),t.u_originX&&e.uniform1f(t.u_originX,o.originX),t.u_originY&&e.uniform1f(t.u_originY,o.originY),t.u_worldWidth&&e.uniform1f(t.u_worldWidth,o.worldWidth),t.u_worldHeight&&e.uniform1f(t.u_worldHeight,o.worldHeight),t.u_fit&&e.uniform1f(t.u_fit,o.fit),t.u_scale&&e.uniform1f(t.u_scale,o.scale),t.u_rotation&&e.uniform1f(t.u_rotation,o.rotation),t.u_offsetX&&e.uniform1f(t.u_offsetX,o.offsetX),t.u_offsetY&&e.uniform1f(t.u_offsetY,o.offsetY),i.presetDirty=!1}function Ge(e){if(!i)return;let{gl:t,uniforms:o,preset:n,glCanvas:r}=i,u=(e-i.startMs-i.pausedMs)/1e3*n.speed;t.viewport(0,0,r.width,r.height),t.clearColor(0,0,0,0),t.clear(t.COLOR_BUFFER_BIT),i.presetDirty&&Ue(),o.u_time&&t.uniform1f(o.u_time,u),t.drawArrays(t.TRIANGLES,0,6),i.frameCount++}var me=0;function he(e){if(!i)return;if(i.contextLost){i.rafId=0;return}let t=!1;for(let o of i.instances)if(o.visible&&(!o.paused||!o.everCopied)){t=!0;break}if(!t){i.rafId=0;return}if(i.rafId=requestAnimationFrame(he),e-me<66){if(k)for(let o of i.glowQueue)o.glowFast&&o.visible&&!o.paused&&(o.glowFast=!!k(o,e));return}me=e,Ge(e),ce(),i.useOffscreen&&(i.frameBitmap?.close(),i.frameBitmap=i.glCanvas.transferToImageBitmap());for(let o of i.instances)o.visible&&(o.paused&&o.everCopied||(ke(o),o.everCopied=!0));if(k&&i.glowQueue.length>0&&++i.glowSkip%1===0)for(let o of i.glowQueue)o.visible&&!o.paused&&(o.glowFast=!!k(o,e))}function U(){!i||i.rafId!==0||(i.rafId=requestAnimationFrame(he))}function ve(){i&&(i.rafId!==0&&cancelAnimationFrame(i.rafId),i.rafId=0)}function be(e,t,o,n){let r=getComputedStyle(o),u=t.getBoundingClientRect(),l=document.createRange();l.selectNodeContents(o);let s=l.getBoundingClientRect();l.detach(),e.save(),e.scale(n,n),e.font=`${r.fontStyle} ${r.fontWeight} ${r.fontSize} ${r.fontFamily}`,e.textAlign="left",e.textBaseline="alphabetic";let c=o.textContent??"",m=e.measureText(c),x=m.fontBoundingBoxAscent??parseFloat(r.fontSize)*.9,d=m.fontBoundingBoxDescent??parseFloat(r.fontSize)*.2,h=s.left-u.left,v=s.top-u.top+(s.height-(x+d))/2+x;e.fillText(c,h,v),e.restore()}var Oe=()=>!ie()||matchMedia("(prefers-reduced-transparency: reduce)").matches||matchMedia("(forced-colors: active)").matches||document.documentElement.classList.contains("solid"),_e=()=>matchMedia("(prefers-reduced-motion: reduce)").matches,we=()=>matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light",ye=!1;function Se(e,{kind:t="pill",ring:o=1.5,mask:n=null,strength:r=1,z:u=0,onFirstCopy:l}={}){if(Oe()||!e)return null;ye||(j("silver",we()),matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>j("silver",we())),ye=!0),getComputedStyle(e).position==="static"&&(e.style.position="relative");let s=document.createElement("canvas");s.setAttribute("aria-hidden","true"),s.className="metal-canvas",s.style.cssText=`position:absolute;inset:0;width:100%;height:100%;pointer-events:none;border-radius:inherit;z-index:${u}`,e.append(s);let c=e.getBoundingClientRect(),m=Math.min(parseFloat(getComputedStyle(e).borderTopLeftRadius)||0,c.height/2),x=fe({hostCanvas:s,cssWidth:Math.max(1,Math.round(c.width)),cssHeight:Math.max(1,Math.round(c.height)),cornerRadius:m,kind:t,ringCssPx:o,opacityMul:r,paused:_e(),mask:n,onFirstCopy:l}),d=new ResizeObserver(()=>{let h=e.getBoundingClientRect();Y(x,{cssWidth:Math.max(1,Math.round(h.width)),cssHeight:Math.max(1,Math.round(h.height))})});return d.observe(e),{destroy(){d.disconnect(),pe(x),s.remove()},pause(h){Y(x,{paused:h||_e()})}}}function De(e,t){return Se(e,{...t,z:0})}function We(e,t,o={}){return Se(e,{...o,z:2,ring:0,mask:(n,r,u,l)=>be(n,e,t,l),onFirstCopy:()=>{t.style.webkitTextFillColor="transparent"}})}window.DebriefMetal={ring:De,text:We};document.dispatchEvent(new Event("debrief-metal-ready"));})();
