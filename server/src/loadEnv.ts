import path from "node:path";
import dotenv from "dotenv";

// __dirnameはserver/dist基準なので、リポジトリ直下の.envは相対パス指定が必要
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
