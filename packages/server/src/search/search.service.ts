import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import { ConfigService } from '../config/config.service';
import {
  DatasetService,
  DatasetForElasticSearch,
} from '../dataset/dataset.service';
import { Dataset } from '../dataset/dataset.entity';
import { ScoredDataset } from './types/ScoredDataset';
import consoleLogObject from '../util/consoleLogObject';

import '@tensorflow/tfjs-node';
import * as use from '@tensorflow-models/universal-sentence-encoder';

@Injectable()
export class SearchService {
  constructor(
    private readonly esService: ElasticsearchService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => DatasetService))
    private readonly datasetService: DatasetService,
  ) {}

  /**
   * This function refreshes the Elasticsearch index (and creates it if it
   * didn't already exist).
   *
   * The options that are expected are:
   * - `recreate` (boolean): whether or not to delete and recreate the index
   * - `lastMetadataUpdateDate` (string): only update datasets whose
   *      `metadataUpdatedAt` date is later than this date. The date should be
   *      a string specified in YYYY-MM-DD format.
   * - `datasetIdsToDelete` (string[]): array of dataset ids to delete.
   * - `portalIds` (string[]): an optional array of portal IDs to restrict our
   *      update.
   * - `skipMLDatasetProcessing` (boolean): whether or not we should skip
   *      processing datasets using tensorflow. This is only really used in
   *      local development to speed up data ingestion during testing.
   */
  async refreshIndex({
    recreate,
    lastMetadataUpdateDate,
    datasetIdsToDelete,
    portalIds = undefined,
    skipMLDatasetProcessing = false,
  }: {
    recreate: boolean;
    lastMetadataUpdateDate: string;
    datasetIdsToDelete: string[];
    portalIds: string[] | undefined;
    skipMLDatasetProcessing: boolean;
  }) {
    console.log('Using elasticsearch index', {
      index: this.configService.get('ELASTICSEARCH_INDEX'),
      node: this.configService.get('ELASTICSEARCH_NODE'),
    });
    await this.createIndex({ recreate });

    // now populate the index
    await this.populateIndex({
      skipMLDatasetProcessing,
      portalIds,
      lastMetadataUpdateDate,
    });

    // now delete datasets from the index
    await this.deleteDatasetsFromIndex(datasetIdsToDelete);
    console.log('Done making changes to Elasticsearch index');
  }

  /**
   * Create a new Elasticsearch index if it doesn't exist already.
   * If `recreate` is true then we will delete the index if it already exists
   * and recreate it.
   */
  async createIndex({ recreate }: { recreate: boolean }) {
    console.log('First checking if index already exists...');

    const checkIndex = await this.esService.indices.exists({
      index: this.configService.get('ELASTICSEARCH_INDEX'),
    });

    const indexExists = checkIndex.statusCode === 200;

    if (recreate && indexExists) {
      console.log('Deleting index so we can recreate it');
      await this.esService.indices.delete({
        index: this.configService.get('ELASTICSEARCH_INDEX'),
      });
      console.log('Index deleted!');
    }

    if (!indexExists || recreate) {
      console.log('Creating index');
      this.esService.indices.create(
        {
          index: this.configService.get('ELASTICSEARCH_INDEX'),
          body: {
            settings: {
              analysis: {
                analyzer: {
                  autocomplete_analyzer: {
                    tokenizer: 'autocomplete',
                    filter: ['lowercase'],
                  },
                  autocomplete_search_analyzer: {
                    tokenizer: 'keyword',
                    filter: ['lowercase'],
                  },
                },
                tokenizer: {
                  autocomplete: {
                    type: 'edge_ngram',
                    min_gram: 1,
                    max_gram: 30,
                    token_chars: ['letter', 'digit', 'whitespace'],
                  },
                },
              },
            },
            mappings: {
              properties: {
                title: {
                  type: 'text',
                  fields: {
                    complete: {
                      type: 'text',
                      analyzer: 'autocomplete_analyzer',
                      search_analyzer: 'autocomplete_search_analyzer',
                    },
                  },
                },
                description: {
                  type: 'text',
                  fields: {
                    complete: {
                      type: 'text',
                      analyzer: 'autocomplete_analyzer',
                      search_analyzer: 'autocomplete_search_analyzer',
                    },
                  },
                },
                portal: {
                  type: 'text',
                },
                vector: {
                  type: 'knn_vector',
                  dimension: 512,
                },
                department: {
                  type: 'text',
                },
                categories: {
                  type: 'text',
                },
                columns: {
                  type: 'text',
                },
                isTest: {
                  type: 'boolean',
                },
              },
            },
          },
        },
        err => {
          if (err) {
            console.error(err);
          }
        },
      );
    } else {
      console.log("Index exists already and we aren't recreating it.");
    }
  }

  async thematicallySimilarForDataset(
    dataset: Dataset,
    portalId?: string,
  ): Promise<ScoredDataset[]> {
    const text = dataset.name + '. ' + dataset.description;
    console.log('finding similar with text ', text);
    return this.findSimilar(text, portalId);
  }

  async findSimilar(
    description: string,
    portalId?: string,
  ): Promise<ScoredDataset[]> {
    const model = await use.load();
    const embedding = await (await model.embed([description])).data();
    console.log('embedding is ', Array.from(embedding));

    const emptyQuery = {
      match_all: {},
    };
    const portalQuery = {
      match: { portal: portalId },
    };
    const query = portalId ? portalQuery : emptyQuery;

    try {
      // Run the elastic search query
      const { body } = await this.esService.search({
        index: this.configService.get('ELASTICSEARCH_INDEX'),
        body: {
          size: 50,
          query: {
            script_score: {
              query: query,
              script: {
                source:
                  "(cosineSimilarity(params.query_vector, doc['vector']) + 1.0)/2.0",
                params: { query_vector: Array.from(embedding) },
              },
            },
          },
        },
      });

      // Extract ids and scores
      const hits = body.hits.hits;
      const ids = hits.map(item => item._id);
      const scores = hits.map(item => item._score);

      //Find the datasets in the full database
      const datasets = await this.datasetService.findByIds(ids);

      //Return as Scored Datasets
      const result = datasets.map((d, i) => ({ dataset: d, score: scores[i] }));
      console.log(result);
      return result;
    } catch (err) {
      console.log(err);
      console.log(err.body.error.failed_shards[0].reason);
      console.log('___________');
      return [];
    }
  }

  async search(
    search = 'car',
    portal?: string,
    offset = 0,
    limit = 20,
    datasetColumns: string[] = [],
    categories: string[] = [],
    departments: string[] = [],
  ) {
    console.log('RUNNING QUERY', {
      search,
      portal,
      offset,
      limit,
      datasetColumns,
    });

    const matchQuery = {
      multi_match: {
        fields: ['title', 'description'],
        query: search,
        fuzziness: 'AUTO',
      },
    };
    const matchAll = { match_all: {} };

    // deprioritize test datasets
    const query = {
      boosting: {
        positive: search && search.length > 0 ? matchQuery : matchAll,
        negative: {
          match: {
            isTest: true,
          },
        },
        negative_boost: 0.01,
      },
    };
    const fullQuery: any[] = [query];

    // add portal query
    const portalMatch = { match: { portal } };
    if (portal) {
      fullQuery.push(portalMatch);
    }

    // add dataset columns query
    if (datasetColumns.length > 0) {
      const columnMatches = datasetColumns.map(columnField => ({
        match: { columns: columnField },
      }));
      fullQuery.push(...columnMatches);
    }

    // add categories query
    if (categories.length > 0) {
      const categoryMatches = categories.map(category => ({
        match: { categories: category },
      }));
      fullQuery.push(...categoryMatches);
    }

    // add departments query
    if (departments.length > 0) {
      const departmentMatches = departments.map(department => ({
        match: { department },
      }));
      fullQuery.push(...departmentMatches);
    }

    consoleLogObject('Running elasticsearch query', {
      index: this.configService.get('ELASTICSEARCH_INDEX'),
      query: fullQuery,
    });

    const searchQuery = {
      bool: {
        must: fullQuery,
      },
    };

    const { body } = await this.esService.search({
      index: this.configService.get('ELASTICSEARCH_INDEX'),
      body: {
        query: searchQuery,
        from: offset,
        size: limit,
        _source: ['title'],
      },
    });
    const hits = body.hits.hits;
    const ids = hits.map(item => item._id);

    // get how many results we found
    // We need to use a `count` query for this because the `search` API
    // maxes out at 10000 results, and if we are doing an all-portal search
    // then we need to get the real count which is bigger than 10k.
    const {
      body: { count },
    } = await this.esService.count({
      index: this.configService.get('ELASTICSEARCH_INDEX'),
      body: {
        query: searchQuery,
      },
    });

    return { ids, total: count };
  }

  //** Populates the elastic search index with one batch of the dataset data */
  async populateIndexBatch(batch) {
    return new Promise((resolve, reject) => {
      this.esService.bulk(
        {
          index: this.configService.get('ELASTICSEARCH_INDEX'),
          body: batch,
        },
        err => {
          if (err) {
            console.log('Failed to insert a batch', err);
            reject(err);
          }
          resolve(undefined);
        },
      );
    });
  }

  async deleteBatchFromIndex(
    batch: Array<{ delete: { _index: string; _id: string } }>,
  ) {
    return new Promise((resolve, reject) => {
      this.esService.bulk(
        {
          index: this.configService.get('ELASTICSEARCH_INDEX'),
          body: batch,
        },
        err => {
          if (err) {
            console.log('Failed to delete a batch', err);
            reject(err);
          }
          resolve(undefined);
        },
      );
    });
  }

  /**
   * Populate the entire elastic search database
   *
   * If `options.portalIds` is provided, then we will only load the
   * datasets from the given portal ids.
   */
  async populateIndex(options: {
    skipMLDatasetProcessing: boolean;
    portalIds?: string[];
    lastMetadataUpdateDate: string;
  }) {
    console.log(
      'Populating Elasticsearch index.\n',
      `Updating only datasets with metadata last changed after ${options.lastMetadataUpdateDate}\n`,
      'Processing dataset batches with the magic of ML (this might take a while)...',
    );
    if (options.skipMLDatasetProcessing) {
      console.log("Actually, we're skipping doing any ML");
    }

    await this.parseAndPopulateData({
      ...options,
      model: await (options.skipMLDatasetProcessing ? undefined : use.load()),
    });

    console.log('Done populating Elasticsearch index');
  }

  async deleteDatasetsFromIndex(datasetIdsToDelete: string[]) {
    console.log(
      `Deleting ${datasetIdsToDelete.length} datasets from Elasticsearch index`,
    );

    if (datasetIdsToDelete.length === 0) {
      console.log('There is nothing to delete!');
      return;
    }

    const deletionBatchSize = 100;

    // create all deletion requests
    const requestBody = datasetIdsToDelete.map(datasetId => ({
      delete: {
        _index: this.configService.get('ELASTICSEARCH_INDEX'),
        _id: datasetId,
      },
    }));

    // split requests into batches
    const deletionBatches: Array<
      Array<{ delete: { _index: string; _id: string } }>
    > = [];
    requestBody.forEach((req, idx) => {
      const batchIdx = Math.floor(idx / deletionBatchSize);
      if (deletionBatches[batchIdx]) {
        deletionBatches[batchIdx].push(req);
      } else {
        deletionBatches[batchIdx] = [req];
      }
    });

    console.log('Sending deletion requests to Elasticsearch...');
    await deletionBatches.reduce(async (previousPromise, nextBatch, index) => {
      await previousPromise;
      console.log(
        'Deleting sub-batch ',
        index + 1,
        ' of ',
        deletionBatches.length,
      );
      return this.deleteBatchFromIndex(nextBatch);
    }, Promise.resolve());

    console.log('Done deleting from Elasticsearch index');
  }

  async generateEmbeddingVectors(
    datasets: DatasetForElasticSearch[],
    model: undefined | any,
  ) {
    const datasetText = datasets.map(d => d.name + '. ' + d.description);
    const embeddings = model
      ? await (await model.embed(datasetText)).data()
      : undefined;

    const datasetsWithVector = datasets.map((d, index) => ({
      ...d,
      portalId: d.portalId,
      vector: embeddings
        ? embeddings.slice(index * 512, (index + 1) * 512)
        : Array(512).fill(0),
    }));
    return datasetsWithVector;
  }

  /**
   * Pull datasets from the database and prepare the batches to load into
   * elasticsearch. We only pull datasets that have a `metadataUpdatedAt` date
   * after the `lastMetadataUpdateDate`.
   *
   * If `options.portalIds` is provided, then we will only load the
   * datasets from the given portal ids.
   */
  async parseAndPopulateData(options: {
    skipMLDatasetProcessing: boolean;
    portalIds?: string[];
    model?: any;
    lastMetadataUpdateDate: string;
  }): Promise<void> {
    console.log('Getting all datasets from db');

    const totalDatasets = options.portalIds
      ? await this.datasetService.countForPortals(
          options.portalIds,
          options.lastMetadataUpdateDate,
        )
      : await this.datasetService.countAll(options.lastMetadataUpdateDate);

    const parsingBatchSize = 500;
    const uploadBatchSize = 100;
    const numBatches = Math.ceil(totalDatasets / parsingBatchSize);

    console.log(
      'Total ',
      totalDatasets,
      ' Batch size ',
      parsingBatchSize,
      ' Number of batches ',
      numBatches,
    );

    await [...Array(numBatches)].reduce(async (prevPromise, _, index) => {
      // wait for the previous promise to resolve
      await prevPromise;
      const datasets =
        await this.datasetService.findAllForElasticSearchInsertion(
          parsingBatchSize,
          index * parsingBatchSize,
          options?.portalIds,
          options.lastMetadataUpdateDate,
        );

      console.log('Processing batch', index, datasets[0].id);
      const datasetsWithVector = await this.generateEmbeddingVectors(
        datasets,
        options.model,
      );

      const body = [];
      datasetsWithVector.forEach(item => {
        try {
          body.push(
            {
              update: {
                _index: this.configService.get('ELASTICSEARCH_INDEX'),
                _id: item.id,
              },
            },
            {
              doc: {
                title: item.name,
                description: item.description,
                vector: Array.from(item.vector),
                portal: item.portalId,
                department: item.department,
                categories: item.categories,
                columns: item.datasetColumnFields,
                isTest: item.isTest,
              },
              doc_as_upsert: true,
            },
          );
        } catch (err) {
          console.log('Unable to map batch for elasticsearch', item);
          throw err;
        }
      });

      // split all prepared data into batches
      const uploadBatches = [];
      body.forEach((inst, index) => {
        const batchIndex = Math.floor(index / (uploadBatchSize * 2));
        if (uploadBatches[batchIndex]) {
          uploadBatches[batchIndex].push(inst);
        } else {
          uploadBatches[batchIndex] = [inst];
        }
      });

      console.log('Loading sub-batches into Elasticsearch...');
      await uploadBatches.reduce(async (previousPromise, nextBatch, index) => {
        await previousPromise;
        console.log(
          'Loading in sub-batch ',
          index + 1,
          ' of ',
          uploadBatches.length,
        );

        return this.populateIndexBatch(nextBatch);
      }, Promise.resolve());
    }, Promise.resolve([]));
  }
}
