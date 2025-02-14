// copyright defined in LICENSE.txt

#pragma once
#include <appbase/application.hpp>

#include "query_config_plugin.hpp"
#include "state_history_lmdb.hpp"

struct lmdb_inst {
    uint32_t                      db_size_gb;
    state_history::lmdb::env      lmdb_env;
    state_history::lmdb::database db;
    state_history::lmdb::config   query_config{};

    lmdb_inst(const boost::filesystem::path& db_path, uint32_t db_size_gb)
        : lmdb_env{db_path, db_size_gb}
        , db{lmdb_env} {}
};

class lmdb_plugin : public appbase::plugin<lmdb_plugin> {
  public:
    APPBASE_PLUGIN_REQUIRES((query_config_plugin))

    lmdb_plugin();
    virtual ~lmdb_plugin();

    virtual void set_program_options(appbase::options_description& cli, appbase::options_description& cfg) override;
    void         plugin_initialize(const appbase::variables_map& options);
    void         plugin_startup();
    void         plugin_shutdown();

    std::shared_ptr<lmdb_inst> get_lmdb_inst();

  private:
    std::shared_ptr<struct lmdb_plugin_impl> my;
};
