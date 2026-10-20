import { describe } from 'vitest';
import { checkSeeds } from './generatedSeeds';

describe('generated maps pass the map checks', () => checkSeeds(100, 200));
