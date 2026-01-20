import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);

// Lambda用設定
Config.setChromiumDisableWebSecurity(true);

// 出力ディレクトリ
Config.setOutputLocation('./out');
