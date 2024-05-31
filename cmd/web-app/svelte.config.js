import adapter from '@sveltejs/adapter-auto';
const config = {
	kit: {
		adapter: adapter()
	}
};

// export default config;
	// kit: {
	// 	adapter: adapter({ 
	// 		pages: 'build',
	// 		assets: 'build',
	// 		fallback: '404.html', 
	// 		precompress: false,
	// 		strict: true,
	// 		trailingSlash: 'always',
	// 	}),
	// }
// };

export default config;
