// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://bopbap.co',
  trailingSlash: 'never',
  markdown: {
    shikiConfig: {
      theme: 'dracula',
      wrap: true,
    },
  },
});
