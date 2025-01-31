// webpack.config.mjs
export default {
  mode: 'development',
  entry: './chart.js',
  output: {
    filename: 'bundle.js',
    path: new URL('./dist', import.meta.url).pathname,
  },
};