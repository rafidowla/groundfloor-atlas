/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0f0f0f',
        foreground: '#ededed',
      },
    },
  },
  plugins: [],
};
