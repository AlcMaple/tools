const fs = require('fs');

const darkColors = {
  'on-secondary-fixed-variant': '#00458d',
  'on-surface': '#e2e2e2',
  'on-tertiary-container': '#3f4040',
  'tertiary-fixed': '#e4e2e2',
  'error': '#ffb4ab',
  'surface-container': '#1f1f1f',
  'surface-variant': '#353535',
  'on-background': '#e2e2e2',
  'inverse-on-surface': '#303030',
  'primary': '#ffb3b8',
  'secondary-fixed': '#d6e3ff',
  'on-error': '#690005',
  'error-container': '#93000a',
  'on-primary': '#5a1923',
  'on-surface-variant': '#d9c1c1',
  'tertiary': '#c8c6c6',
  'primary-fixed-dim': '#ffb2b8',
  'tertiary-container': '#acabab',
  'surface-bright': '#393939',
  'inverse-primary': '#94464f',
  'on-primary-fixed': '#3e0410',
  'surface-dim': '#131313',
  'on-primary-fixed-variant': '#772f38',
  'secondary-fixed-dim': '#aac7ff',
  'on-primary-container': '#6e2932',
  'primary-container': '#f09199',
  'on-secondary': '#002f64',
  'secondary-container': '#004c9a',
  'on-tertiary-fixed': '#1b1c1c',
  'surface-container-high': '#2a2a2a',
  'background': '#131313',
  'primary-fixed': '#ffdadb',
  'surface': '#131313',
  'on-tertiary-fixed-variant': '#464747',
  'on-tertiary': '#303030',
  'on-error-container': '#ffdad6',
  'surface-container-low': '#1b1b1b',
  'on-secondary-fixed': '#001b3e',
  'tertiary-fixed-dim': '#c8c6c6',
  'secondary': '#aac7ff',
  'on-secondary-container': '#9ec0ff',
  'surface-container-lowest': '#0e0e0e',
  'surface-tint': '#ffb2b8',
  'surface-container-highest': '#353535',
  'outline-variant': '#544343',
  'outline': '#a18c8c',
  'inverse-surface': '#e2e2e2'
};

const specLightColors = {
  'primary': '#94464f',
  'primary-container': '#f09199',
  'surface': '#f8f9fa',
  'surface-container-lowest': '#ffffff',
  'surface-container-low': '#f3f4f5',
  'surface-container': '#edeeef',
  'surface-bright': '#f8f9fa',
  'on-surface': '#191c1d',
  'secondary': '#586062',
  'tertiary': '#166c45',
  'outline-variant': '#d9c1c1',
  'background': '#f8f9fa'
};

function hexToRgb(hex) {
  let r = 0, g = 0, b = 0;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 7) {
    r = parseInt(hex[1] + hex[2], 16);
    g = parseInt(hex[3] + hex[4], 16);
    b = parseInt(hex[5] + hex[6], 16);
  }
  return `${r} ${g} ${b}`;
}

// Map some of the missing light colors from dark inverse or calculate approximations
const lightColors = { ...darkColors };

for (const key of Object.keys(lightColors)) {
  // Try to find if there's an inverse in the dark theme that we can use as light
  if (key.startsWith('inverse-') && darkColors[key.substring(8)]) {
    // If it's an inverse color, it might not be a direct mapping, but let's leave it to the next step
  }
  
  if (specLightColors[key]) {
    lightColors[key] = specLightColors[key];
  } else {
    // Basic heuristic for auto-generating light mode
    // 1. If it's "on-...", text usually needs to be dark in light mode
    // 2. If it's "surface-...", bg is usually light
    
    // Defaulting missing light colors to sensible values
    if (key.includes('on-')) {
      // Dark text
      if (key === 'on-primary') lightColors[key] = '#FFFFFF';
      else if (key === 'on-secondary') lightColors[key] = '#ffffff';
      else if (key === 'on-tertiary') lightColors[key] = '#ffffff';
      else if (key === 'on-error') lightColors[key] = '#ffffff';
      else if (key.includes('container')) lightColors[key] = '#1A1A1A';
      else Object.assign(lightColors, { [key]: '#191C1D' });
    } else if (key.includes('surface') || key.includes('background')) {
      // Light backgrounds
      if (key === 'surface-variant') lightColors[key] = '#e7e8e9'; // lighter variant
      else if (key === 'surface-container-high') lightColors[key] = '#e3e4e5';
      else if (key === 'surface-container-highest') lightColors[key] = '#dfdfe0';
      else if (key === 'inverse-surface') lightColors[key] = '#2e3032';
      else if (key === 'inverse-on-surface') lightColors[key] = '#f0f1f2';
      else Object.assign(lightColors, { [key]: '#F8F9FA' });
    } else if (key === 'outline') {
      lightColors[key] = '#70787a';
    } else if (key === 'error') {
      lightColors[key] = '#ba1a1a';
    } else if (key === 'error-container') {
      lightColors[key] = '#ffdad6';
    } else {
      // For fixed colors, they often stay the same or invert cleanly.
      if (key.includes('-fixed')) {
         // keep it or slightly alter
         lightColors[key] = darkColors[key];
      } else {
         // Keep dark color as fallback if unknown (should ideally not happen much)
         lightColors[key] = darkColors[key];
      }
    }
  }
}

// Explicit overrides matching typical Material 3 Light patterns based on primary #94464F
const explicitLightOverrides = {
  'on-primary': '#ffffff',
  'primary-container': '#ffd9dc',
  'on-primary-container': '#3e0410',
  'secondary': '#755659',
  'on-secondary': '#ffffff',
  'secondary-container': '#ffd9dc',
  'on-secondary-container': '#2c1518',
  'tertiary': '#166c45', // from spec
  'on-tertiary': '#ffffff',
  'tertiary-container': '#a0f5c3',
  'on-tertiary-container': '#002111',
  'error': '#ba1a1a',
  'on-error': '#ffffff',
  'error-container': '#ffdad6',
  'on-error-container': '#410002',
  'background': '#fdf8f8',
  'on-background': '#1c1b1b',
  'surface': '#f8f9fa',
  'on-surface': '#191c1d',
  'surface-variant': '#f4dddd',
  'on-surface-variant': '#524344',
  'outline': '#847374',
  'outline-variant': '#d9c1c1',
  'inverse-surface': '#313030',
  'inverse-on-surface': '#f4eff0',
  'inverse-primary': '#ffb3b8',
  // surface containers
  'surface-container-lowest': '#ffffff',
  'surface-container-low': '#f3f4f5',
  'surface-container': '#edeeef',
  'surface-container-high': '#e3e4e5',
  'surface-container-highest': '#dfdfe0',
  'surface-bright': '#f8f9fa',
  'surface-dim': '#ded8d9',
};

// Apply all overrides
Object.keys(explicitLightOverrides).forEach(key => {
  if (darkColors[key]) {
     lightColors[key] = explicitLightOverrides[key];
  }
});

// Enforce spec colors (highest priority)
Object.keys(specLightColors).forEach(key => {
  if (darkColors[key]) {
     lightColors[key] = specLightColors[key];
  }
});

let rootValues = [];
let darkValues = [];
let twColors = [];

for (const [key, value] of Object.entries(darkColors)) {
  const lightHex = lightColors[key];
  const darkHex = value;
  
  rootValues.push(`    --color-${key}: ${hexToRgb(lightHex)}; /* ${lightHex} */`);
  darkValues.push(`    --color-${key}: ${hexToRgb(darkHex)}; /* ${darkHex} */`);
  twColors.push(`        '${key}': 'rgb(var(--color-${key}) / <alpha-value>)'`);
}

const outputStr = "========== CSS VARIABLES (Root) ==========\n" +
`@layer base {
  :root {
${rootValues.join('\n')}
  }

  .dark {
${darkValues.join('\n')}
  }
}` + "\n\n========== TAILWIND COLORS ==========\n" + twColors.join(',\n');

fs.writeFileSync('scripts/theme_output.txt', outputStr);
