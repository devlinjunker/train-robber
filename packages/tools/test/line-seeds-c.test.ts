import { describe } from 'vitest';
import { checkLineSeeds } from './generatedSeeds';

describe('open lines pass the map checks', () => checkLineSeeds(100, 150));
