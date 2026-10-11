// Prints the arguments it received as JSON, so a test can see exactly what reached the program.
process.stdout.write(JSON.stringify(process.argv.slice(2)));
