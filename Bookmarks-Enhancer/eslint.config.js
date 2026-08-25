module.exports = [
	{
		ignores: ["src/browser-polyfill.js"]
	},
	{
		files: ["src/**/*.js"],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "script"
		},
		rules: {}
	}
];
