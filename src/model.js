// 数据模型基类
// by YuRonghui 2018-1-31
const Redis = require('./redis');
const Mongo = require('./mongo');
const Mysql = require('./mysql');
const Util = require('./util');
const cluster = require('cluster');
const {
  error,
  catchErr
} = Util;
let largelimit = 20000; //限制不能超过2万条数据返回
const _timeout = 0;
const _KeyTimeout = 60 * 1; //设置listkey过期时间，秒

class Model {
  constructor(opts = {}) {
    this.tableName = opts.tableName;
    this.fields = opts.fields || {};
    this.select = opts.select || {};
  }

  // 设置getter和setter
  _get_set() {
    let obj = {}, fieldMap = this.fields.fieldMap;
    for (let key in fieldMap) {
      obj[key] = {
        get() {
          if (CONFIG.isDebug) console.warn(`getter: ${key}`);
          return fieldMap[key].value || fieldMap[key].defaultValue;
        },
        set(val) {
          if (CONFIG.isDebug) console.warn(`setter: ${key}, ${val}`);
          fieldMap[key].value = val;
        }
      }
    }
    return obj;
  }

  _init() {
    let fields = this.fields.data || {};
    for (let key in fields) {
      let item = fields[key];
      if (key == '_id') continue;
      // 建索引
      if (item.index) {
        if(cluster.worker == null || CONFIG.service.initloop.workerid == cluster.worker.id){
          let indexField = {};
          indexField[key] = item.index == 'text' ? item.index : 1 ;
          this.db.index(indexField);
        }
      }
      //表关联
      if (item.key && item.as && item.from) {
        this.relation = this.relation || {};
        if (item) {
          this.relation[key] = item;
        }
      }
    }
    return Object.create(this, this._get_set());
  }

  // 创建索引
  createIndex(opts = {}) {
    if (!Util.isEmpty(opts)) this.db.collection.ensureIndex(opts);
  }

  // 删除索引
  removeIndex(name) {
    if (name) this.db.collection.dropIndex(name);
  }

  // 设置数据
  setData(target, value) {
    this.fields.setData(target, value);
  }

  // 获取模型数据
  getData(hasVirtualField = true) {
    return this.fields.getData(hasVirtualField);
  }

  // 是否新的
  isNew() {
    return !this.rowid;
  }

  //新增数据
  async create(data) {
    if (!data) throw error('create方法的参数data不能为空');
    let rowid = await this.redis.rowid();
    if (CONFIG.isDebug) console.warn('新增rowid: ', rowid);
    if (rowid || data.rowid == 0) {
      data.rowid = rowid;
      this.setData(data);
      let err = this.fields.validate();
      if (err) throw error(err);
      const lock = await catchErr(this.redis.lock());
      if (lock.data) {
        return this.db.create(this.getData());
      }else{
        throw error(lock.err);
      }
    }
    throw error(false);
  }

  // 更新数据
  async update(data, required = false) {
    if (!data) throw error('update方法的参数data不能为空');
    if (!this.isNew() || data.rowid) {
      let err = this.fields.validate(),
        hasSet = false,
        rowid = this.rowid || data.rowid;
      if (!required) err = false;
      if (err) {
        throw error(err);
      } else {
        let isLock = await catchErr(this.redis.lock());
        if (isLock.data) {
          delete data.rowid;
          let keys = Object.keys(data);
          hasSet = keys[0].indexOf('$') === 0;
          const result = await catchErr(this.db.update({ rowid }, hasSet ? data : { $set: data }));
          if (result.data){
            return { rowid };
          }else{
            throw error(result.err);
          }
        }else{
          throw error(isLock.err);
        }
      }
    }
    throw error(false);
  }

  // 保存数据
  async save() {
    let data = this.getData(false);
    if (Util.isEmpty(data) || !data) throw error('save方法的data为空');
    if (!this.isNew() || data.rowid) {
      const updateOk = await catchErr(this.update(data));
      if (updateOk.err) throw error(updateOk.err);
      return updateOk.data;
    } else {
      const result = await catchErr(this.create(data));
      if (result.err) throw error(result.err);
      return result.data;
    }
  }

  //删除数据
  async remove(data) {
    if (!data) return false;
    const lock = await catchErr(this.redis.lock());
    if (lock.data) {
      return this.db.remove(data);
    }else{
      throw error(lock.err);
    }
  }

  //清空数据
  async clear() {
    const lock = await catchErr(this.redis.lock());
    if (lock.data) {
      return this.db.clear();
    }else{
      throw error(lock.err);
    }
  }

  // 查询条件对象
  query(req = {}) {
    let where = {}, body = Util.getParams(req);
    if(body && body.data) where = body.data.where || {};
    let query = this.db.query({ where });
    if(!Util.isEmpty(body)){
      let obj = {};
      for (let key in body) {
        if (!this.fields.data[key]) continue;
        if (Array.isArray(body.data[key])) {
          obj[key] = {
            $in: body.data[key]
          };
        } else {
          if(typeof body.data[key] == 'object'){
            if(body.data[key].like){ // 模糊查询
              obj[key] = {
                $regex: body.data[key].like
              };
            }else if(body.data[key].search){ // 全文搜索
              obj['$text'] = {
                $search: body.data[key].search
              };
            }else{
              obj[key] = body.data[key];
            }
          }else{
            obj[key] = {
              $eq: body.data[key]
            };
          }
        }
      }
      query.where(obj);
    }
    query.req = req;
    return query;
  }

  // 查询单条记录
  async findOne(data, addLock = true) {
    const hasLock = addLock ? await catchErr(this.redis.hasLock()) : {};
    if(hasLock.err){
      throw error(hasLock.err);
    }else{
      if (!hasLock.data) {
        let query = data._isQuery ? data : this.query();
        if (typeof data === 'number') {
          query.where({
            rowid: data
          });
        } else if (typeof data === 'object') {
          query.where(data);
        }
        query.select(this.select);
        if (!Util.isEmpty(this.relation)) query.populate(this.relation);
        return query.exec('one') || {};
      } else {
        await new Promise((resolve, reject) => {
          setTimeout(() => {
            resolve(true);
          }, _timeout);
        });
        return this.findOne(data, addLock);
      }
    }
  }

  // 查询数据列表
  async findList(data, hasCache, addLock = true) {
    if (!data) throw error('findList方法参数data不能为空');
    let hasLock = addLock ? await catchErr(this.redis.hasLock()) : {data: 0};
    if(hasLock.err){
      throw error(hasLock.err);
    }else{
      if (!hasLock.data) {
        let query = {}, listKey = '', hasKey = false;
        if(data._isQuery){
          query = data;
        }else{
          query = this.query();
          let limit = data.limit == undefined ? 20 : Number(data.limit),
            page = data.page || 1;
          data.largepage = data.largepage || 1;
          page = page % Math.ceil(largelimit / limit) || 1;
          if(query.req && query.req.url){
            listKey = await Util.getListKey(query.req); //生成listkey
            hasKey = await this.redis.existKey(listKey); //key是否存在
            if (!hasCache && hasKey) {
              await this.redis.delKey(listKey); //删除已有的key
              hasKey = false;
            }
            if (hasKey) {
              let startIndex = (page - 1) * limit;
              data.rowid = await this.redis.listSlice(listKey, startIndex, startIndex + limit - 1);
              data.rowid = data.rowid.map(item => parseInt(item));
            }
          }
          query.where(data);
        }
        if (CONFIG.isDebug) console.warn(`请求列表, ${hasKey ? '有' : '无'}listKey`);
        if (!Util.isEmpty(this.relation)) query.populate(this.relation);
        const countResult = await catchErr(this.db.count(query));
        const docsResult = await catchErr(query.exec('list'));
        if (docsResult.err || countResult.err) {
          throw error(docsResult.err || countResult.err);
        }else{
          let docs = docsResult.data;
          // 缓存rowid
          if (!query.hasKey && docs.length) {
            if (docs.length >= largelimit) {
              data.largepage = data.largepage || 1;
              let startNum = (data.largepage - 1) * largelimit;
              docs = docs.slice(startNum, startNum + largelimit);
            }
            await this.redis.listPush(query.listKey, docs.map(item => item.rowid));
            this.redis.setKeyTimeout(query.listKey, _KeyTimeout); //设置listkey一小时后过期
            return this.findList(data, false, addLock);
          } else {
            return {
              count: Number(countResult.data),
              list: docs || []
            };
          }
        }
        return [];
      }else{
        await new Promise((resolve, reject) => {
          setTimeout(() => {
            resolve(true);
          }, _timeout);
        });
        return this.findList(data, hasCache, addLock);
      }
    }
  }
}

module.exports = Model;
