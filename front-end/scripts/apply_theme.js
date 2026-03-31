const fs = require('fs');

const themeOutputStr = fs.readFileSync('scripts/theme_output.txt', 'utf-8');
const sections = themeOutputStr.split('========== TAILWIND COLORS ==========');

const cssVars = sections[0].replace('========== CSS VARIABLES (Root) ==========\n', '').trim();
const twColorsStr = sections[1].trim();

// Update index.css
const indexCssPath = 'src/renderer/src/index.css';
let indexCss = fs.readFileSync(indexCssPath, 'utf-8');
if (!indexCss.includes(':root {')) {
  indexCss = indexCss.replace('@tailwind utilities;', `@tailwind utilities;\n\n${cssVars}\n`);
  fs.writeFileSync(indexCssPath, indexCss);
  console.log('Updated index.css');
} else {
  console.log('index.css already contains :root, skipping.');
}

// Update tailwind.config.js
const twConfigPath = 'tailwind.config.js';
let twConfig = fs.readFileSync(twConfigPath, 'utf-8');
const colorsStart = twConfig.indexOf('colors: {');
if (colorsStart !== -1) {
  // Find the matching brace for colors: {
  let braceCount = 1;
  let colorsEnd = -1;
  const startIdx = colorsStart + 'colors: {'.length;
  for (let i = startIdx; i < twConfig.length; i++) {
    if (twConfig[i] === '{') braceCount++;
    if (twConfig[i] === '}') braceCount--;
    if (braceCount === 0) {
      colorsEnd = i;
      break;
    }
  }
  
  if (colorsEnd !== -1) {
    const newColorsBlock = `colors: {\n${twColorsStr}\n      }`;
    twConfig = twConfig.slice(0, colorsStart) + newColorsBlock + twConfig.slice(colorsEnd + 1);
    fs.writeFileSync(twConfigPath, twConfig);
    console.log('Updated tailwind.config.js');
  } else {
    console.log('Could not find end brace for colors block');
  }
} else {
  console.log('Could not find colors: { in tailwind.config.js');
}
