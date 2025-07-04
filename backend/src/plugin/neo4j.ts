import fp from 'fastify-plugin';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { FastifyPluginAsync } from 'fastify';

export interface Neo4jPluginOptions {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

export interface PurchaseData {
  id?: string;
  description?: string;
  price: number;
  date: string | Date;
  tags?: string[];
  userId: string;
  categoryId?: string;
}

// Déclaration Fastify
declare module 'fastify' {
  interface FastifyInstance {
    neo4j: {
      driver: Driver;
      getSession: () => Session;
      createPurchase: (data: PurchaseData) => Promise<any>;
      getPurchases: (options: {
        userId: string;
        categoryId?: string;
        startDate?: string;
        endDate?: string;
        limit?: number;
        offset?: number;
      }) => Promise<any[]>;
      updatePurchase: (id: string, userId: string, updateData: Partial<PurchaseData>) => Promise<any>;
      deletePurchase: (id: string, userId: string) => Promise<boolean>;
      getPurchaseStats: (options: {
        userId: string;
        startDate?: string;
        endDate?: string;
      }) => Promise<{
        totalAmount: number;
        totalCount: number;
        categoriesStats: any[];
      }>;
      getMonthlyPurchaseStats: (options: {
        userId: string;
        startDate?: string;
        endDate?: string;
        months?: number;
      }) => Promise<{
        months: string[];
        categoryStats: {
          categoryId: string;
          monthlyAmounts: number[];
        }[];
      }>;
      ensureUserExists: (userId: string) => Promise<void>;
      ensureCategoryExists: (categoryId: string) => Promise<void>;
    };
  }
}

const neo4jPlugin: FastifyPluginAsync<Neo4jPluginOptions> = async (fastify, options) => {
  const { uri, username, password, database } = options;

  const driver = neo4j.driver(
    uri,
    neo4j.auth.basic(username, password),
    {
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 30000,
      encrypted: process.env.NODE_ENV === 'production',
    }
  );

  try {
    await driver.verifyConnectivity();
    fastify.log.info('Connexion à Neo4j établie avec succès');
  } catch (error) {
    fastify.log.error('Échec de connexion à Neo4j:', error);
    throw error;
  }

  const getSession = () => driver.session({ database });

  function formatDate(neoDate: any): Date {
    if (!neoDate) return new Date();
    if (typeof neoDate === 'string') return new Date(neoDate);
    if (neoDate.year && neoDate.month) {
      return new Date(
        neoDate.year.toNumber(),
        neoDate.month.toNumber() - 1,
        neoDate.day.toNumber(),
        neoDate.hour.toNumber(),
        neoDate.minute.toNumber(),
        neoDate.second.toNumber(),
        neoDate.nanosecond.toNumber() / 1_000_000
      );
    }
    return new Date();
  }

  function formatPurchase(node: any): any {
    return {
      id: node.id,
      description: node.description,
      price: typeof node.price === 'number' ? node.price : node.price.toNumber(),
      date: formatDate(node.date),
      tags: Array.isArray(node.tags) ? node.tags : [],
      userId: node.userId,
      categoryId: node.categoryId,
      createdAt: formatDate(node.createdAt),
      updatedAt: formatDate(node.updatedAt)
    };
  }

  async function ensureUserExists(userId: string): Promise<void> {
    const session = getSession();
    try {
      await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (u:User {id: $userId})
          `,
          { userId }
        )
      );
    } finally {
      await session.close();
    }
  }

  async function ensureCategoryExists(categoryId: string): Promise<void> {
    const session = getSession();
    try {
      await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (c:Category {id: $categoryId})
          `,
          { categoryId }
        )
      );
    } finally {
      await session.close();
    }
  }

  async function createPurchase(purchaseData: PurchaseData): Promise<any> {
    const session = getSession();
    try {
      let query;
      let params: any = {
        userId: purchaseData.userId,
        description: purchaseData.description || '',
        price: purchaseData.price,
        date: new Date(purchaseData.date).toISOString(),
        tags: purchaseData.tags || []
      };

      if (purchaseData.categoryId) {
        params.categoryId = purchaseData.categoryId;
        // Tout en une seule transaction atomique pour éviter les doublons
        query = `
          MERGE (u:User {id: $userId})
          MERGE (c:Category {id: $categoryId})
          CREATE (p:Purchase {
            id: randomUUID(),
            description: $description,
            price: $price,
            date: datetime($date),
            tags: $tags,
            createdAt: datetime(),
            updatedAt: datetime()
          })
          CREATE (p)-[:MADE_BY]->(u)
          CREATE (p)-[:BELONGS_TO]->(c)
          RETURN p, c.id AS categoryId
        `;
      } else {
        // Création sans catégorie
        query = `
          MERGE (u:User {id: $userId})
          CREATE (p:Purchase {
            id: randomUUID(),
            description: $description,
            price: $price,
            date: datetime($date),
            tags: $tags,
            createdAt: datetime(),
            updatedAt: datetime()
          })
          CREATE (p)-[:MADE_BY]->(u)
          RETURN p, null AS categoryId
        `;
      }

      const result = await session.executeWrite(tx =>
        tx.run(query, params)
      );

      const record = result.records[0];
      if (!record) throw new Error('Aucun enregistrement retourné');

      const purchase = formatPurchase(record.get('p').properties);
      const categoryId = record.get('categoryId');

      return {
        ...purchase,
        categoryId: categoryId
      };
    } finally {
      await session.close();
    }
  }

  async function getPurchases({
    userId,
    categoryId,
    startDate,
    endDate,
    limit = 50,
    offset = 0
  }: {
    userId: string;
    categoryId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const session = getSession();
    try {
      await ensureUserExists(userId);

      const params: any = { userId, limit: neo4j.int(limit), offset: neo4j.int(offset) };
      let query = `
        MATCH (p:Purchase)-[:MADE_BY]->(u:User {id: $userId})
        WHERE 1=1
      `;

      // Construire les conditions de date d'abord
      if (startDate) {
        query += ` AND p.date >= datetime($startDate)`;
        params.startDate = new Date(startDate).toISOString();
      }
      if (endDate) {
        query += ` AND p.date <= datetime($endDate)`;
        params.endDate = new Date(endDate).toISOString();
      }

      // Ensuite filtrer par catégorie si nécessaire
      if (categoryId) {
        query += `
        WITH p
        MATCH (p)-[:BELONGS_TO]->(c:Category)
        WHERE c.id = $categoryId
        `;
        params.categoryId = categoryId;
      } else {
        query += `
        WITH p
        OPTIONAL MATCH (p)-[:BELONGS_TO]->(c:Category)
        `;
      }

      query += `
        RETURN p, c
        ORDER BY p.date DESC
        SKIP $offset
        LIMIT $limit
      `;

      const result = await session.executeRead(tx => tx.run(query, params));

      return result.records.map(record => {
        const purchase = formatPurchase(record.get('p').properties);
        const category = record.get('c');
        return {
          ...purchase,
          categoryId: category ? category.properties.id : null
        };
      });
    } finally {
      await session.close();
    }
  }

  async function updatePurchase(id: string, userId: string, updateData: Partial<PurchaseData>): Promise<any> {
    const session = getSession();
    try {
      const check = await session.executeRead(tx =>
        tx.run(
          `MATCH (p:Purchase {id: $id})-[:MADE_BY]->(u:User {id: $userId}) RETURN p`,
          { id, userId }
        )
      );
      if (check.records.length === 0) return null;

      const setClauses = ['p.updatedAt = datetime()'];
      const params: any = { id, userId };

      if (updateData.description !== undefined) {
        setClauses.push('p.description = $description');
        params.description = updateData.description;
      }
      if (updateData.price !== undefined) {
        setClauses.push('p.price = $price');
        params.price = updateData.price;
      }
      if (updateData.date !== undefined) {
        setClauses.push('p.date = datetime($date)');
        params.date = new Date(updateData.date).toISOString();
      }
      if (updateData.tags !== undefined) {
        setClauses.push('p.tags = $tags');
        params.tags = updateData.tags;
      }

      let query = `
        MATCH (p:Purchase {id: $id})-[:MADE_BY]->(u:User {id: $userId})
        MATCH (p)-[r:BELONGS_TO]->(:Category)
      `;

      if (updateData.categoryId) {
        await ensureCategoryExists(updateData.categoryId);
        query += `
          DELETE r
          WITH p
          MATCH (c:Category {id: $categoryId})
          CREATE (p)-[:BELONGS_TO]->(c)
        `;
        params.categoryId = updateData.categoryId;
      } else {
        query += `WITH p, r `;
      }

      query += `
        SET ${setClauses.join(', ')}
        WITH p
        MATCH (p)-[:BELONGS_TO]->(c:Category)
        RETURN p, c
      `;

      const result = await session.executeWrite(tx => tx.run(query, params));
      if (result.records.length === 0) return null;

      return {
        ...formatPurchase(result.records[0].get('p').properties),
        categoryId: result.records[0].get('c').properties.id
      };
    } finally {
      await session.close();
    }
  }

  async function deletePurchase(id: string, userId: string): Promise<boolean> {
    const session = getSession();
    try {
      const check = await session.executeRead(tx =>
        tx.run(
          `MATCH (p:Purchase {id: $id})-[:MADE_BY]->(u:User {id: $userId}) RETURN p`,
          { id, userId }
        )
      );
      if (check.records.length === 0) return false;

      await session.executeWrite(tx =>
        tx.run(
          `MATCH (p:Purchase {id: $id})-[:MADE_BY]->(u:User {id: $userId}) DETACH DELETE p`,
          { id, userId }
        )
      );

      return true;
    } finally {
      await session.close();
    }
  }

async function getPurchaseStats({
  userId,
  startDate,
  endDate
}: {
  userId: string;
  startDate?: string;
  endDate?: string;
}) {
  const session = getSession();
  try {
    await ensureUserExists(userId);

    let whereClause = '';
    const params: any = { userId };

    if (startDate) {
      whereClause += ' p.date >= datetime($startDate)';
      params.startDate = new Date(startDate).toISOString();
    }

    if (endDate) {
      whereClause += ' AND p.date <= datetime($endDate)';
      params.endDate = new Date(endDate).toISOString();
    }

    // Totaux globaux
    const totalsQuery = `
      MATCH (p:Purchase)-[:MADE_BY]->(u:User {id: $userId})
      WHERE ${whereClause}
      RETURN 
        sum(p.price) AS totalAmount,
        count(p) AS totalCount
    `;

    const totalsResult = await session.executeRead(tx => tx.run(totalsQuery, params));
    const totalsRecord = totalsResult.records[0];

    const rawTotalAmount = totalsRecord.get('totalAmount');
    const totalAmount =
      typeof rawTotalAmount === 'number'
        ? rawTotalAmount
        : rawTotalAmount && typeof rawTotalAmount.toNumber === 'function'
          ? rawTotalAmount.toNumber()
          : 0;

    const rawTotalCount = totalsRecord.get('totalCount');
    const totalCount =
      typeof rawTotalCount === 'number'
        ? rawTotalCount
        : rawTotalCount && typeof rawTotalCount.toNumber === 'function'
          ? rawTotalCount.toNumber()
          : 0;

    // Statistiques par catégorie
    const statsByCategoryQuery = `
      MATCH (p:Purchase)-[:MADE_BY]->(u:User {id: $userId})
      WHERE ${whereClause}
      OPTIONAL MATCH (p)-[:BELONGS_TO]->(c:Category)
      WITH p, c
      WITH c.id AS categoryId, sum(p.price) AS categoryTotal, count(p) AS categoryCount
      RETURN 
        CASE WHEN categoryId IS NULL THEN 'other' ELSE categoryId END AS categoryId,
        categoryTotal,
        categoryCount
      ORDER BY categoryTotal DESC
    `;

    const statsByCategoryResult = await session.executeRead(tx => tx.run(statsByCategoryQuery, params));

    const categoriesStats = statsByCategoryResult.records.map(record => {
      const rawCategoryTotal = record.get('categoryTotal');
      const categoryTotal =
        typeof rawCategoryTotal === 'number'
          ? rawCategoryTotal
          : rawCategoryTotal && typeof rawCategoryTotal.toNumber === 'function'
            ? rawCategoryTotal.toNumber()
            : 0;

      const rawCategoryCount = record.get('categoryCount');
      const categoryCount =
        typeof rawCategoryCount === 'number'
          ? rawCategoryCount
          : rawCategoryCount && typeof rawCategoryCount.toNumber === 'function'
            ? rawCategoryCount.toNumber()
            : 0;

      return {
        categoryId: record.get('categoryId'),
        totalAmount: categoryTotal,
        count: categoryCount
      };
    });

    return {
      totalAmount,
      totalCount,
      categoriesStats
    };
  } finally {
    await session.close();
  }
}

async function getMonthlyPurchaseStats({
  userId,
  startDate,
  endDate,
  months = 6
}: {
  userId: string;
  startDate?: string;
  endDate?: string;
  months?: number;
}) {
  const session = getSession();
  try {
    await ensureUserExists(userId);

    // Si pas de date de fin, utiliser la date actuelle
    const end = endDate ? new Date(endDate) : new Date();
    
    // Si pas de date de début, utiliser les X derniers mois
    let start;
    if (startDate) {
      start = new Date(startDate);
    } else {
      start = new Date(end);
      start.setMonth(start.getMonth() - (months - 1)); // -5 pour avoir 6 mois au total
      start.setDate(1); // Premier jour du mois
      start.setHours(0, 0, 0, 0);
    }
    
    // Générer la liste des mois à inclure dans la requête
    const monthList: string[] = [];
    for (let i = 0; i < months; i++) {
      const date = new Date(start);
      date.setMonth(date.getMonth() + i);
      
      // Format année-mois (2023-01)
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      monthList.push(`${year}-${month}`);
    }
    
    const params: any = { 
      userId,
      startDate: start.toISOString(),
      endDate: end.toISOString()
    };
    
    // Requête pour obtenir les achats par mois et par catégorie
    const query = `
      MATCH (p:Purchase)-[:MADE_BY]->(u:User {id: $userId})
      WHERE p.date >= datetime($startDate) AND p.date <= datetime($endDate)
      OPTIONAL MATCH (p)-[:BELONGS_TO]->(c:Category)
      WITH 
        p,
        CASE WHEN c IS NULL THEN 'other' ELSE c.id END AS categoryId,
        datetime(p.date).year + '-' + 
        CASE 
          WHEN datetime(p.date).month < 10 THEN '0' + datetime(p.date).month 
          ELSE datetime(p.date).month 
        END AS yearMonth
      WITH 
        categoryId, 
        yearMonth,
        sum(p.price) AS monthTotal
      RETURN 
        categoryId,
        yearMonth,
        monthTotal
      ORDER BY 
        yearMonth, 
        categoryId
    `;
    
    const result = await session.executeRead(tx => tx.run(query, params));
    
    // Organiser les résultats
    const categoryMonthTotals = new Map<string, Map<string, number>>();
    
    // Initialiser la structure
    result.records.forEach(record => {
      const categoryId = record.get('categoryId');
      const yearMonth = record.get('yearMonth');
      const monthTotal = 
        typeof record.get('monthTotal') === 'number' 
          ? record.get('monthTotal')
          : record.get('monthTotal').toNumber();
      
      if (!categoryMonthTotals.has(categoryId)) {
        categoryMonthTotals.set(categoryId, new Map<string, number>());
      }
      
      categoryMonthTotals.get(categoryId)!.set(yearMonth, monthTotal);
    });
    
    // Transformer les données au format souhaité
    const categoryStats = Array.from(categoryMonthTotals.entries()).map(([categoryId, monthValues]) => {
      const monthlyAmounts = monthList.map(month => 
        monthValues.get(month) || 0
      );
      
      return {
        categoryId,
        monthlyAmounts
      };
    });
    
    return {
      months: monthList.map(yearMonth => {
        const [year, month] = yearMonth.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1);
        return date.toLocaleString('default', { month: 'long', year: 'numeric' });
      }),
      categoryStats
    };
  } finally {
    await session.close();
  }
}

  fastify.decorate('neo4j', {
    driver,
    getSession,
    createPurchase,
    getPurchases,
    updatePurchase,
    deletePurchase,
    getPurchaseStats,
    getMonthlyPurchaseStats,
    ensureUserExists,
    ensureCategoryExists
  });

  fastify.addHook('onClose', async () => {
    await driver.close();
    fastify.log.info('Connexion Neo4j fermée');
  });
};

export default fp(neo4jPlugin, {
  name: 'neo4j',
  dependencies: ['prisma']
});
