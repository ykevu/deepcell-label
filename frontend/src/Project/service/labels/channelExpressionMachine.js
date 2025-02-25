/** Makes calculations related to channel expression (mean, total, etc.) for
 * plotting and cell type clustering.
 */

import { UMAP } from 'umap-js';
import { actions, assign, Machine, send } from 'xstate';
import { pure } from 'xstate/lib/actions';
import Cells from '../../cells';
import { fromEventBus } from '../eventBus';

const { choose } = actions;

const createChannelExpressionMachine = ({ eventBuses }) =>
  Machine(
    {
      id: 'channelExpression',
      invoke: [
        {
          id: 'eventBus',
          src: fromEventBus('channelExpression', () => eventBuses.channelExpression),
        },
        {
          id: 'channelExpression',
          src: fromEventBus('channelExpression', () => eventBuses.channelExpression, 'CALCULATION'),
        },
        {
          id: 'arrays',
          src: fromEventBus('channelExpression', () => eventBuses.arrays, 'LABELED'),
        },
        { id: 'cells', src: fromEventBus('channelExpression', () => eventBuses.cells, 'CELLS') },
        { id: 'load', src: fromEventBus('channelExpression', () => eventBuses.load, 'LOADED') },
        { src: fromEventBus('channelExpression', () => eventBuses.image, 'SET_T') },
        { src: fromEventBus('channelExpression', () => eventBuses.labeled, 'SET_FEATURE') },
      ],
      context: {
        t: 0,
        feature: 0,
        labeled: null, // currently displayed labeled frame (Int32Array[][])
        raw: null, // current displayed raw frame (?Array[][])
        cells: null,
        numCells: null,
        calculations: null,
        reduction: null,
        calculation: null,
      },
      initial: 'loading',
      on: {
        LABELED: { actions: 'setLabeled' },
        CELLS: { actions: ['setCells', 'setNumCells'] },
        SET_T: { actions: 'setT' },
        SET_FEATURE: { actions: 'setFeature' },
      },
      states: {
        loading: {
          type: 'parallel',
          states: {
            getRaw: {
              initial: 'waiting',
              states: {
                waiting: {
                  on: {
                    LOADED: { actions: 'setRaw', target: 'done' },
                  },
                },
                done: { type: 'final' },
              },
            },
            getLabels: {
              initial: 'waiting',
              states: {
                waiting: {
                  on: {
                    LABELED: { actions: 'setLabeled', target: 'done' },
                  },
                },
                done: { type: 'final' },
              },
            },
          },
          onDone: { target: 'loaded' },
        },
        loaded: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                CALCULATE: { target: 'calculating' },
                CALCULATE_UMAP: { target: 'visualizing' },
              },
            },
            calculating: {
              entry: choose([
                {
                  cond: (_, evt) => evt.stat === 'Mean',
                  actions: ['setStat', 'calculateMean'],
                },
                {
                  cond: (_, evt) => evt.stat === 'Total',
                  actions: ['setStat', 'calculateTotal'],
                },
              ]),
              always: 'idle',
            },
            visualizing: {
              entry: choose([
                {
                  cond: (_, evt) => evt.stat === 'Mean',
                  actions: ['setStat', 'calculateMean'],
                },
                {
                  cond: (_, evt) => evt.stat === 'Total',
                  actions: ['setStat', 'calculateTotal'],
                },
              ]),
              on: {
                CALCULATION: { actions: 'calculateUmap', target: 'idle' },
              },
            },
          },
        },
      },
    },
    {
      actions: {
        setRaw: assign({ raw: (_, evt) => evt.rawOriginal }),
        setLabeled: assign({ labeled: (_, evt) => evt.labeled }),
        setCells: assign({ cells: (_, evt) => evt.cells }),
        setNumCells: assign({ numCells: (_, evt) => new Cells(evt.cells).getNewCell() }),
        setT: assign({ t: (_, evt) => evt.t }),
        setFeature: assign({ feature: (_, evt) => evt.feature }),
        setStat: assign({ calculation: (_, evt) => evt.stat }),
        calculateMean: pure((ctx) => {
          const { t, feature, labeled, raw, cells, numCells } = ctx;
          const width = labeled[0].length;
          const height = labeled.length;
          const numChannels = raw.length;
          const cellStructure = new Cells(cells);
          let valueMapping = {};
          for (let i = 0; i < height; i++) {
            for (let j = 0; j < width; j++) {
              const value = labeled[i][j];
              if (valueMapping[value] === undefined) {
                valueMapping[value] = cellStructure.getCellsForValue(value, t, feature);
              }
            }
          }
          let totalValues = Array.from({ length: numChannels }, () => new Array(numCells).fill(0));
          let cellSizes = Array.from({ length: numChannels }, () => new Array(numCells).fill(0));
          let channelMeans = Array.from({ length: numChannels }, () => new Array(numCells).fill(0));
          for (let c = 0; c < numChannels; c++) {
            for (let i = 0; i < height; i++) {
              for (let j = 0; j < width; j++) {
                const cellList = valueMapping[labeled[i][j]];
                for (const cell of cellList) {
                  totalValues[c][cell] = totalValues[c][cell] + raw[c][t][i][j];
                  cellSizes[c][cell] = cellSizes[c][cell] + 1;
                }
              }
            }
          }
          for (let c = 0; c < numChannels; c++) {
            for (let i = 0; i < numCells; i++) {
              channelMeans[c][i] = totalValues[c][i] / cellSizes[c][i];
            }
          }
          return [
            assign({ calculations: channelMeans }),
            send({ type: 'CALCULATION', calculations: channelMeans }, { to: 'eventBus' }),
          ];
        }),
        calculateTotal: pure((ctx) => {
          const { t, feature, labeled, raw, cells, numCells } = ctx;
          const width = labeled[0].length;
          const height = labeled.length;
          const numChannels = raw.length;
          const cellStructure = new Cells(cells);
          let valueMapping = {};
          for (let i = 0; i < height; i++) {
            for (let j = 0; j < width; j++) {
              const value = labeled[i][j];
              if (valueMapping[value] === undefined) {
                valueMapping[value] = cellStructure.getCellsForValue(value, t, feature);
              }
            }
          }
          let totalValues = Array.from({ length: numChannels }, () => new Array(numCells).fill(0));
          let cellSizes = Array.from({ length: numChannels }, () => new Array(numCells).fill(0));
          for (let c = 0; c < numChannels; c++) {
            for (let i = 0; i < height; i++) {
              for (let j = 0; j < width; j++) {
                const cellList = valueMapping[labeled[i][j]];
                for (const cell of cellList) {
                  totalValues[c][cell] = totalValues[c][cell] + raw[c][t][i][j];
                  cellSizes[c][cell] = cellSizes[c][cell] + 1;
                }
              }
            }
          }
          for (let i = 0; i < numCells; i++) {
            if (cellSizes[0][i] === 0) {
              for (let c = 0; c < numChannels; c++) {
                totalValues[c][i] = NaN;
              }
            }
          }
          return [
            assign({ calculations: totalValues }),
            send({ type: 'CALCULATION', calculations: totalValues }, { to: 'eventBus' }),
          ];
        }),
        calculateUmap: assign({
          reduction: (ctx) => {
            const { raw, calculations } = ctx;
            const numChannels = raw.length;
            let vectors = [];
            let maxes = Array(numChannels).fill(0);
            for (let i = 0; i < calculations[0].length; i++) {
              let vector = [];
              for (let c = 0; c < numChannels; c++) {
                const calc = calculations[c][i];
                if (isNaN(calc)) {
                  vector.push(0);
                } else {
                  if (calc > maxes[c]) {
                    maxes[c] = calc;
                  }
                  vector.push(calc);
                }
              }
              if (!calculations.every((channel) => isNaN(channel[i]))) {
                vectors.push(vector);
              }
            }
            vectors = vectors.map((vector) =>
              vector.map((calc, i) => (maxes[i] === 0 ? 0 : calc / maxes[i]))
            );
            const umap = new UMAP();
            const embeddings = umap.fit(vectors);
            let x = [];
            let y = [];
            let embeddingCount = 0;
            for (let i = 0; i < calculations[0].length; i++) {
              if (calculations.every((channel) => isNaN(channel[i]))) {
                x.push(NaN);
                y.push(NaN);
              } else {
                x.push(embeddings[embeddingCount][0]);
                y.push(embeddings[embeddingCount][1]);
                embeddingCount++;
              }
            }
            return [x, y];
          },
        }),
      },
    }
  );

export default createChannelExpressionMachine;
