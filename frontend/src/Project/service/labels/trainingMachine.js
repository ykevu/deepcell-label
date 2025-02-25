/** Perform tensorflow.js training using embeddings and labeled cell types as input data
 */

import { actions, assign, Machine, send } from 'xstate';
import * as tf from '@tensorflow/tfjs';
import { fromEventBus } from '../eventBus';

const { choose } = actions;

// https://stackoverflow.com/questions/11301438/return-index-of-greatest-value-in-an-array
export function argMax(arr) {
  if (arr.length === 0) {
      return -1;
  }
  var max = arr[0];
  var maxIndex = 0;
  for (var i = 1; i < arr.length; i++) {
      if (arr[i] > max) {
          maxIndex = i;
          max = arr[i];
      }
  }
  return maxIndex;
};

export function getLabelsFromCell(cellTypes, cell) {
  const types = cellTypes.filter((cellType) => cellType.cell.includes(cell));
  const labels = types.map((cellType) => cellType.id);
  return labels;
};

export function getLabelFromCell(cellTypes, cell) {
  // Assuming that there is only one label per cell
  const type = cellTypes.filter((cellType) => cellType.cells.includes(cell))[0];
  return type.id;
};

export function getCellList(cellTypes) {
  const cellsList = cellTypes.map((cellType) => cellType.cells).flat();
  return [...new Set(cellsList)];
};

function convertToTensor(cells, embedding, cellTypes, maxId, valSplit) {
  // Convert cells and embedding lists into tensors

  return tf.tidy(() => {
    // Convert to tensor
    const inputs = cells.map(i => embedding[i]);
    const labels = cells.map(cell => getLabelFromCell(cellTypes, cell) - 1);
    const numExamples = inputs.length;
    const unshuffledInput = tf.tensor2d(inputs, [numExamples, inputs[0].length]);
    const unshuffledLabels = tf.oneHot(tf.tensor1d(labels, 'int32'), maxId);

    // Shuffle training data
    let indices = [...Array(cells.length).keys()];
    tf.util.shuffle(indices);
    const inputTensor = unshuffledInput.gather(indices);
    const labelTensor = unshuffledLabels.gather(indices);

    // Normalize input data
    const inputMax = inputTensor.max();
    const inputMin = inputTensor.min();

    const normalizedInputs = inputTensor.sub(inputMin).div(inputMax.sub(inputMin));

    // Split training data
    const trainSize = Math.ceil(numExamples * valSplit);
    const valSize = numExamples - trainSize;
    const [trainInputs, valInputs] = tf.split(normalizedInputs, [trainSize, valSize], 0);
    const [trainLabels, valLabels] = tf.split(labelTensor, [trainSize, valSize], 0);

    return {
      trainInputs: trainInputs,
      trainLabels: trainLabels,
      valInputs: valInputs,
      valLabels: valLabels,
      // Return the min/max bounds so we can use them later.
      inputMax,
      inputMin,
    }
  });
};

function getUnlabeledTensor(cells, embedding) {
  const unlabeled = embedding.map((vector, cell) => 
    cells.includes(cell) || vector.every((c) => isNaN(c)) ? false : true);
  const unlabeledList = embedding.filter((vector, cell) => 
    !cells.includes(cell) && !vector.every((c) => isNaN(c)));
  const unlabeledTensor = tf.tensor2d(unlabeledList);
  return {
    unlabeled: unlabeled,
    unlabeledTensor: unlabeledTensor,
  }
};

function getPredictions(pred, unlabeled) {
  const predArr = pred.arraySync();
  let j = 0;
  let predMap = {};
  for (let i = 0; i < unlabeled.length; i++) {
    if (unlabeled[i] === true) {
      predMap[i] = argMax(predArr[j]);
      j += 1;
    }
  }
  return predMap;
};

function createModel(inputShape, units) {
   // Sequential model
   const model = tf.sequential();
   // Add input layer
   model.add(tf.layers.dense({inputShape: inputShape, units: 1, useBias: true}));
   // Add output layer
   model.add(tf.layers.dense({units: units, activation: 'softmax'}));

   return model;
};

async function trainModel(model, trainInputs, trainLabels, valInputs, valLabels, sendBack, batchSize, epochs, lr) {
   // Prepare the model for training.
   model.compile({
     optimizer: tf.train.adam(lr),
     loss: (trainLabels.shape[1] === 2) ? 'binaryCrossentropy' : 'categoricalCrossentropy',
     metrics: ['accuracy'],
   });

   return await model.fit(trainInputs, trainLabels, {
     batchSize,
     epochs,
     shuffle: true,
     validationData: [valInputs, valLabels],
     callbacks: {
       onEpochEnd: (epoch, logs) => {
         sendBack({ type: 'SET_EPOCH', epoch: epoch, logs: logs });
       },
     },
  });
};

function calculateConfusion(model, valInputs, valLabels) {
  const pred = model.predict(valInputs);
  const numClasses = valLabels.arraySync()[0].length;
  const decodedPredictions = pred.arraySync().map((logits) => argMax(logits));
  const decodedLabels = valLabels.arraySync().map((oneHot) => argMax(oneHot));
  const confusionMatrix = tf.math.confusionMatrix(decodedLabels, decodedPredictions, numClasses).arraySync();
  const normalized = confusionMatrix.map((row) => {
    const sum = row.reduce((partialSum, e) => partialSum + e, 0);
    return row.map((e) => e / sum);
  })
  return normalized;
};

async function train(ctx, evt, sendBack) {
  let vectors = [];
  for (let i = 0; i < ctx.calculations[0].length; i++) {
    let vector = [];
    for (let c = 0; c < ctx.numChannels; c++) {
      vector.push(ctx.calculations[c][i]);
    }
    vectors.push(vector);
  }
  const cells = getCellList(ctx.cellTypes);
  const ids = ctx.cellTypes.map(cellType => cellType.id);
  let maxId = 0;
  if (ids.length > 0) {
    maxId = Math.max.apply(null, ids);
  }
  const { trainInputs, trainLabels, valInputs, valLabels, inputMax, inputMin } = convertToTensor(cells, vectors, ctx.cellTypes, maxId, ctx.valSplit);

  const model = createModel([trainInputs.shape[1]], trainLabels.shape[1]);
  await trainModel(model, trainInputs, trainLabels, valInputs, valLabels, sendBack, ctx.batchSize, ctx.numEpochs, ctx.learningRate);
  const confusionMatrix = calculateConfusion(model, valInputs, valLabels);
  // Finish by sending the trained model back to parent
  sendBack({type: 'DONE', model: model, confusionMatrix: confusionMatrix, inputMax: inputMax, inputMin: inputMin });
};

async function predict(ctx, evt) {
  let vectors = [];
  for (let i = 0; i < ctx.calculations[0].length; i++) {
    let vector = [];
    for (let c = 0; c < ctx.numChannels; c++) {
      vector.push(ctx.calculations[c][i]);
    }
    vectors.push(vector);
  }
  const [inputMin, inputMax] = ctx.range;
  const cells = getCellList(ctx.cellTypes);
  const { unlabeled, unlabeledTensor } = getUnlabeledTensor(cells, vectors);
  const normalized = unlabeledTensor.sub(inputMin).div(inputMax.sub(inputMin));
  const pred = ctx.model.predict(normalized);
  const predMap = await getPredictions(pred, unlabeled);
  return predMap;
}

const createTrainingMachine = ({ eventBuses }) =>
  Machine(
    {
      id: 'training',
      invoke: [
        { id: 'eventBus', src: fromEventBus('training', () => eventBuses.training) },
        { id: 'load', src: fromEventBus('training', () => eventBuses.load, 'LOADED') },
        { id: 'cellTypes', src: fromEventBus('training', () => eventBuses.cellTypes) },
        { id: 'channelExpression', src: fromEventBus('training', () => eventBuses.channelExpression) },
        { src: fromEventBus('training', () => eventBuses.image, 'SET_T') },
        { src: fromEventBus('training', () => eventBuses.labeled, 'SET_FEATURE') },
      ],
      context: {
        embedding: 'Mean',
        batchSize: 1,
        numEpochs: 20,
        learningRate: 0.01,
        valSplit: 0.8,
        confusionMatrix: null,
        t: 0,
        feature: 0,
        epoch: 0,
        range: null,
        numChannels: null, // from raw
        cellTypes: null,
        calculations: null,
        model: null,
        valLogs: [],
        trainLogs: [],
      },
      initial: 'loading',
      on: {
        CELLTYPES: { actions: 'setCellTypes' },
        SET_T: { actions: 'setT' },
        SET_FEATURE: { actions: 'setFeature' },
      },
      states: {
         loading: {
           type: 'parallel',
           states: {
             getCellTypes: {
               initial: 'waiting',
               states: {
                 waiting: {
                   on: {
                     LOADED: { actions: 'setCellTypes', target: 'done' },
                   },
                 },
                 done: { type: 'final' },
               },
             },
             getRaw: {
              initial: 'waiting',
              states: {
                waiting: {
                  on: {
                    LOADED: { actions: 'setNumChannels', target: 'done' },
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
                 TRAIN: { target: 'training' },
                 PREDICT: { target: 'predicting' },
                 EMBEDDING: { actions: 'setEmbedding' },
                 BATCH_SIZE: { actions: 'setBatchSize' },
                 LEARNING_RATE: { actions: 'setLearningRate' },
                 NUM_EPOCHS: { actions: 'setNumEpochs' },
                 VAL_SPLIT: { actions: 'setValSplit' },
               },
             },
             training: {
               initial: 'calculating',
               states: {
                  calculating: {
                    entry: choose([
                      {
                        cond: (ctx) => ctx.embedding === 'Mean',
                        actions: ['resetEpoch', 'resetLogs', 'getMean'],
                      },
                      {
                        cond: (ctx) => ctx.embedding === 'Total',
                        actions: ['resetEpoch', 'resetLogs', 'getTotal'],
                      },
                    ]),
                    on: {
                      CALCULATION: { actions: 'setCalculation', target: 'train' },
                    },
                  },
                  train: {
                    invoke: {
                      id: 'training',
                      src: (ctx, evt) => (sendBack) => {
                        // TO-DO: handle errors in the training function
                        train(ctx, evt, sendBack);
                      },
                      // onError: { target: 'idle', actions: (c, e) => console.log(c, e) },
                    },
                    on: {
                      SET_EPOCH: { actions: ['setEpoch', 'setLogs'] },
                    }
                  }
               },
               on: {
                CANCEL: { target: 'idle' },
                DONE: {
                  target: 'idle',
                  actions: ['saveModel', 'setConfusionMatrix', 'setRange'],
                },
               }
             },
             predicting: {
              //  entry: choose([
              //    {
              //      cond: (ctx) => ctx.embedding === 'Mean',
              //      actions: 'getMean',
              //    },
              //    {
              //      cond: (ctx) => ctx.embedding === 'Total',
              //      actions: 'getTotal',
              //    },
              //  ]),
               invoke: {
                 id: 'predicting',
                 src: predict,
                 onDone: {
                   target: 'idle',
                   actions: 'sendPredictions',
                 },
                 // TODO: send error message to parent and display in UI
                 onError: { target: 'idle', actions: ['sendApiError', (c, e) => console.log(c, e)] },
               },
             }
           },
         },
      },
    },
    {
      actions: {
        setBatchSize: assign({ batchSize: (_, evt) => evt.batchSize }),
        setEmbedding: assign({ embedding: (_, evt) => evt.embedding }),
        setNumEpochs: assign({ numEpochs: (_, evt) => evt.numEpochs }),
        setLearningRate: assign({ learningRate: (_, evt) => evt.learningRate }),
        setValSplit: assign({ valSplit: (_, evt) => evt.valSplit }),
        setNumChannels: assign({ numChannels: (_, evt) => evt.raw.length }),
        setCellTypes: assign({ cellTypes: (_, evt) => evt.cellTypes }),
        setT: assign({ t: (_, evt) => evt.t }),
        setFeature: assign({ feature: (_, evt) => evt.feature }),
        setEpoch: assign({ epoch: (_, evt) => evt.epoch }),
        setLogs: assign({
          valLogs: (ctx, evt) => ctx.valLogs.concat([evt.logs.val_loss]),
          trainLogs: (ctx, evt) => ctx.trainLogs.concat([evt.logs.loss]),
        }),
        setCalculation: assign({ calculations: (_, evt) => evt.calculations }),
        setConfusionMatrix: assign({ confusionMatrix: (_, evt) => evt.confusionMatrix }),
        getMean: send({ type: 'CALCULATE', stat: 'Mean' }, { to: 'channelExpression' }),
        getTotal: send({ type: 'CALCULATE', stat: 'Total' }, { to: 'channelExpression' }),
        resetLogs: assign({
          valLogs: [],
          trainLogs: [],
        }),
        resetEpoch: assign({ epoch: () => 0}),
        saveModel: assign({ model: (_, evt) => evt.model }),
        setRange: assign({ range: (_, evt) => [evt.inputMin, evt.inputMax] }),
        sendPredictions: send((_, evt) => ({ type: 'ADD_PREDICTIONS', predictions: evt.data }), { to: 'cellTypes', }),
      },
    }
  );

export default createTrainingMachine;
