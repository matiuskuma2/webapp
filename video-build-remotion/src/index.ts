/**
 * RILARC Remotion エントリポイント
 * 
 * このファイルは Remotion のコンポジション登録を行います。
 */

import { registerRoot } from 'remotion';
import { RilarcRoot } from './Root';

registerRoot(RilarcRoot);
