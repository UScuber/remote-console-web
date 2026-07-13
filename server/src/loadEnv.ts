import path from 'node:path';
import dotenv from 'dotenv';

// .envはリポジトリ直下に置く運用のため、パスを指定して読み込む
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
