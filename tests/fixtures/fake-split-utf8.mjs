// Writes "é" (two UTF-8 bytes) split across two separate writes, then a newline.
const b = Buffer.from('é\n');
process.stdout.write(b.subarray(0, 1), () => setTimeout(() => process.stdout.write(b.subarray(1)), 50));
