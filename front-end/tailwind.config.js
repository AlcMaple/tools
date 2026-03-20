/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}', './src/renderer/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
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
      },
      fontFamily: {
        'headline': ['Inter', 'sans-serif'],
        'body': ['Inter', 'sans-serif'],
        'label': ['Space Grotesk', 'sans-serif']
      },
      borderRadius: {
        DEFAULT: '0.125rem',
        lg: '0.25rem',
        xl: '0.5rem',
        full: '0.75rem'
      }
    }
  },
  plugins: []
}
